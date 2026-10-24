/**
 * Electron 日志存储适配器
 * 通过 IPC 与主进程通信，实现日志的文件存储
 */

import type {
  ILogStorage,
  LogErrorData,
  LogFilter
} from './types';

/**
 * IndexedDB 数据库名称（用于本地缓存）
 * 与 Web 存储保持一致
 */
const DB_NAME = 'MonopolyLogs';
const STORE_NAME = 'logs';

/**
 * IndexedDB 操作类（用于本地缓存）
 */
class IndexedDBHelper {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('level', 'level', { unique: false });
          store.createIndex('category', 'category', { unique: false });
        }
      };
    });
  }

  async add(log: LogErrorData): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(log);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async getAll(): Promise<LogErrorData[]> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async delete(id: string): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

/**
 * Electron 日志存储实现
 * 使用 IndexedDB 作为本地缓存，同时通过 IPC 与主进程通信
 */
export class ElectronLogStorage implements ILogStorage {
  private idb = new IndexedDBHelper();
  private initialized = false;
  private loadedFromFile = false;

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.idb.init();
      this.initialized = true;
    }
  }

  /**
   * 从文件加载日志到缓存
   * 注意：如果 Electron 主进程未实现 getLogs API，则跳过文件加载
   * 新日志仍会同时写入文件（通过 logError IPC）和 IndexedDB
   */
  private async loadFromFileIfNeeded(): Promise<void> {
    if (!this.loadedFromFile && window.platformAPI?.getHistoryLogs) {
      try {
        const fileLogs = await window.platformAPI.getHistoryLogs();
        for (const log of fileLogs) {
          await this.idb.add(log);
        }
        this.loadedFromFile = true;
      } catch (error) {
        console.error('[ElectronLogStorage] 从文件加载日志失败:', error);
      }
    }
    // 如果 API 不存在，直接跳过 - 日志仍会写入 IndexedDB
  }

  async add(log: LogErrorData): Promise<void> {
    await this.ensureInit();
    // 存储到 IndexedDB 缓存
    await this.idb.add(log);
  }

  async getAll(): Promise<LogErrorData[]> {
    await this.ensureInit();
    await this.loadFromFileIfNeeded();
    return await this.idb.getAll();
  }

  async get(filter?: LogFilter): Promise<LogErrorData[]> {
    await this.ensureInit();
    await this.loadFromFileIfNeeded();
    let logs = await this.idb.getAll();

    if (filter) {
      logs = logs.filter(log => {
        if (filter.levels && !filter.levels.includes(log.level)) {
          return false;
        }
        if (filter.categories && !filter.categories.includes(log.category)) {
          return false;
        }
        if (filter.startTime) {
          const logDate = new Date(log.createdAt);
          if (logDate < filter.startTime) return false;
        }
        if (filter.endTime) {
          const logDate = new Date(log.createdAt);
          if (logDate > filter.endTime) return false;
        }
        if (filter.keyword) {
          const keyword = filter.keyword.toLowerCase();
          const searchText = `${log.message} ${log.stack || ''} ${JSON.stringify(log.context)}`.toLowerCase();
          if (!searchText.includes(keyword)) return false;
        }
        return true;
      });
    }

    return logs;
  }

  async clear(before?: Date): Promise<void> {
    await this.ensureInit();

    if (!before) {
      // 清空所有
      await this.idb.clear();
    } else {
      // 清空指定日期之前的日志
      const logs = await this.idb.getAll();
      const toDelete = logs.filter(log => new Date(log.createdAt) < before);
      for (const log of toDelete) {
        await this.idb.delete(log.id);
      }
    }
  }

  async deleteById(id: string): Promise<void> {
    await this.ensureInit();
    await this.idb.delete(id);
  }

  async count(): Promise<number> {
    await this.ensureInit();
    const logs = await this.idb.getAll();
    return logs.length;
  }
}

export default ElectronLogStorage;
