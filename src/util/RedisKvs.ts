import {cpus} from 'os';
import pmap from 'p-map';
import fastq from 'fastq';
import deepmerge from 'deepmerge';
import type {RedisClient} from 'redis';

const chunkSize = 10;


interface ScanResult {
  cursor: string;
  items: string[][];
}


export class RedisKvs<T> {
  private redisClient: RedisClient;
  private readonly dbName: string;
  private readonly keyMapping?: { [key: string]: string };
  private readonly invertedKeyMapping?: { [key: string]: string };

  constructor(redisClient: RedisClient, dbName: string, keyMapping?: { [key: string]: string }) {
    this.redisClient = redisClient;
    this.dbName = dbName;
    this.keyMapping = keyMapping;
    if (keyMapping) {
      this.invertedKeyMapping = Object.entries(keyMapping).reduce((acc, [key, val]) => ({...acc, [val]: key}), {});
    }
  }

  public get(prop: string) {
    return new Promise<T>((resolve, reject) => {
      this.redisClient.hget(this.dbName, prop, (err, val) => {
        if (err) {
          reject(err);
        } else {
          const d = JSON.parse(val);
          const mappedVal = this.mapKeysGet(d);
          resolve(mappedVal);
        }
      });
    });
  }

  public getMany(prop: string[]) {
    return new Promise<KVS<T>>((resolve, reject) => {
      this.redisClient.hmget(this.dbName, prop, (err, val) => {
        if (err) {
          reject(err);
        } else {
          resolve(
            val
              .map((a) => JSON.parse(a))
              .reduce((acc, val, index) => {
                return {
                  ...acc,
                  [prop[index]]: this.mapKeysGet(val),
                };
              }, {} as KVS<T>),
          );
        }
      });
    });
  }

  public exists(prop: string[]): Promise<{ [key: string]: number }> {
    return pmap(
      prop,
      (key: string) => {
        return new Promise((resolve, reject) => {
          this.redisClient.hexists(this.dbName, key, (err, val) => {
            if (err) {
              reject(err);
            } else {
              resolve({[key]: val});
            }
          });
        });
      },
      {concurrency: cpus().length * 4}
    ).then((vals: any[]) => vals.reduce((acc, val) => Object.assign(acc, val), {}));
  }

  public set(prop: string, val: T) {
    return new Promise((resolve, reject) => {
      const valToSet = this.mapKeysSet(val);
      this.redisClient.hset(this.dbName, prop, RedisKvs.normalize(valToSet), (err, val) => {
        if (err) {
          reject(err);
        } else {
          resolve(val);
        }
      });
    });
  }

  public setMany(val: KVS<T>) {
    return new Promise((resolve, reject) => {
      const numKeys = Object.keys(val).length;
      if (!numKeys) {
        resolve();
        return;
      }
      this.redisClient.hmset(this.dbName, this.normalizeMany(val), (err, val) => {
        if (err) {
          reject(err);
        } else {
          resolve(val);
        }
      });
    });
  }

  public async addMany(items: KVS<T>, idsToKeep: string[] = []) {
    if (idsToKeep.length === 0) idsToKeep = Object.keys(items);
    const itemsToKeep = await this.getMany(idsToKeep);
    await this.setMany(
      deepmerge(
        itemsToKeep,
        items
      ),
    );
  }

  public delete(prop: string) {
    return new Promise((resolve, reject) => {
      this.redisClient.hdel(this.dbName, prop, (err, val) => {
        if (err) {
          reject(err);
        } else {
          resolve(val);
        }
      });
    });
  }

  public deleteMany(prop: string[]) {
    return new Promise((resolve, reject) => {
      this.redisClient.hdel(this.dbName, prop.join(' '), (err, val) => {
        if (err) {
          reject(err);
        } else {
          resolve(val);
        }
      });
    });
  }

  public keys() {
    return new Promise<string[]>((resolve, reject) => {
      this.redisClient.hkeys(this.dbName, (err, val) => {
        if (err) {
          reject(err);
        } else {
          resolve(val);
        }
      });
    });
  }

  public len() {
    return new Promise<number>((resolve, reject) => {
      this.redisClient.hlen(this.dbName, (err, val) => {
        if (err) {
          reject(err);
        } else {
          resolve(val);
        }
      });
    });
  }

  public async iterateItems(numWorkers: number, func: (items: KVS<T>) => Promise<any>) {

    const results: any[] = [];
    let completed = false;

    return new Promise(async (resolve, reject) => {
      const q = fastq(this.worker, Math.ceil(numWorkers / chunkSize));

      q.pause();
      setTimeout(() => q.resume(), 100);

      q.saturated = () => {
        q.pause();
        setTimeout(() => q.resume(), 100);
      }

      q.drain = () => {
        if (completed) resolve(results);
      }

      let cursor = '0';
      do {
        const data = await this.scan(cursor, chunkSize.toString());
        const {items} = data;
        q.push({items, func}, (e, stat) => {
          results.push(stat);
        });
        cursor = data.cursor;
        if (cursor === '0') completed = true;
      } while (!completed);
    });
  }

  private worker = ({items, func}: { items: string[][], func: (items: KVS<T>) => Promise<any> }, cb: any) => {
    // for testing purposes
    const ids: any[] = [];
    const chunkStat: any = {};

    const parsedItems: KVS<T> = items.reduce((acc, [key, strVal]) => ({
      ...acc,
      [key]: this.mapKeysGet(JSON.parse(strVal)),
    }), {} as KVS<T>);

    // for testing purposes
    if (process.env.NODE_ENV === 'test') {
      const count = items.length;
      if (!chunkStat[count]) {
        chunkStat[count] = 1;
      } else {
        chunkStat[count]++;
      }

      for (const item of Object.values(parsedItems)) {
        // @ts-ignore
        ids.push(item.n);
      }
    }

    if (Object.keys(parsedItems).length !== 0) {
      try {
        func(parsedItems).then(() => cb(null, {ids, chunkStat}))
      } catch (e) {
        throw e;
        console.error(e);
        cb(e)
      }
    }
  };

  public scan(scanCursor: string, count: string = '10'): Promise<ScanResult> {
    return new Promise<ScanResult>((resolve, reject) => {
      this.redisClient.hscan(this.dbName, scanCursor, 'COUNT', count, (err, [cursor, data]) => {
        if (err) return reject(err);
        // extract the items from Redis response
        const items = Array.from(data, (x, k) => k % 2 ? undefined : [x, data[k + 1]]).filter((x) => x);
        resolve({cursor, items});
      });
    });
  }

  public flush() {
    return new Promise<void>((resolve, reject) => {
      this.redisClient.del(this.dbName, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private mapKeysGet(obj: any): T {
    let mappedVal = obj;
    if (obj && this.keyMapping && typeof obj === 'object') {
      mappedVal = Object.entries(obj)
        .reduce((acc, [key, val]) => {
          if (this.keyMapping[key]) {
            const newKey = this.keyMapping[key];
            return {...acc, [newKey]: val};
          } else {
            return {...acc, [key]: val};
          }
        }, {});
    }
    return mappedVal;
  }

  private mapKeysSet(obj: any): T {
    let mappedVal = obj;
    if (obj && this.invertedKeyMapping && typeof obj === 'object') {
      mappedVal = Object.entries(obj)
        .reduce((acc, [key, val]) => {
          if (this.invertedKeyMapping[key]) {
            const newKey = this.invertedKeyMapping[key];
            return {...acc, [newKey]: val};
          } else {
            return {...acc, [key]: val};
          }
        }, {});
    }
    return mappedVal;
  }

  private normalizeMany(val: KVS<any>): KVS<string> {
    return Object.entries(val)
      .reduce((acc: KVS<string>, [key, val]) => {
        const newVal = this.mapKeysSet(val);
        acc[key] = RedisKvs.normalize(newVal);
        return acc;
      }, {});
  }

  private static normalize(val: any): string {
    return typeof val !== 'string' ? JSON.stringify(val) : val as string;
  }
}
