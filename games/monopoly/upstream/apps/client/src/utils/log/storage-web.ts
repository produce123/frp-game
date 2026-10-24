/**
 * Web 日志存储适配器
 * 使用 IndexedDB 实现日志持久化
 */

import type {
  ILogStorage,
  LogErrorData,
  LogFilter,
  ErrorLevel,
  ErrorCategory
} from './types';

/**
 * IndexedDB 配置
 */
const DB_NAME = 'MonopolyLogs';
const DB_VERSION = 1;
const STORE_NAME = 'logs';

/**
 * 最大日志数量限制
 */
const MAX_LOGS = 1000;

/**
 * Web 日志存储实现
 * 使用 IndexedDB 持久化存储
 */
export class WebLogStorage implements ILogStorage {
  private db: IDBDatabase | null = null;
  private initialized = false;

  /**
   * 初始化数据库
   */
  private async init(): Promise<void> {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this.initialized = true;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 创建日志存储
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          // 创建索引以便快速查询
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('level', 'level', { unique: false });
          store.createIndex('category', 'category', { unique: false });
        }
      };
    });
  }

  /**
   * 确保 DB 已初始化
   */
  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  /**
   * 清理旧日志（保持最多 MAX_LOGS 条）
   * 使用游标高效删除，避免加载全部数据
   */
  private async cleanupOldLogs(): Promise<void> {
    const count = await this.count();
    if (count <= MAX_LOGS) {
      return;
    }

    const toDeleteCount = count - MAX_LOGS;

    return new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      // 使用索引按时间排序，直接删除最旧的记录
      const index = store.index('createdAt');
      const request = index.openCursor(null, 'next'); // 从最旧开始
      let deletedCount = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor && deletedCount < toDeleteCount) {
          cursor.delete();
          deletedCount++;
          cursor.continue();
        } else {
          // 删除完成
        }
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  /**
   * 添加日志
   */
  async add(log: LogErrorData): Promise<void> {
    await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(log);

      request.onsuccess = async () => {
        // 添加后检查是否需要清理
        await this.cleanupOldLogs();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 获取所有日志
   */
  async getAll(): Promise<LogErrorData[]> {
    await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 根据筛选条件获取日志
   */
  async get(filter?: LogFilter): Promise<LogErrorData[]> {
    await this.ensureInit();
    let logs = await this.getAll();

    if (filter) {
      logs = logs.filter(log => {
        // 等级筛选
        if (filter.levels && !filter.levels.includes(log.level)) {
          return false;
        }
        // 分类筛选
        if (filter.categories && !filter.categories.includes(log.category)) {
          return false;
        }
        // 时间筛选
        if (filter.startTime) {
          const logDate = new Date(log.createdAt);
          if (logDate < filter.startTime) return false;
        }
        if (filter.endTime) {
          const logDate = new Date(log.createdAt);
          if (logDate > filter.endTime) return false;
        }
        // 关键词筛选
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

  /**
   * 清空日志
   */
  async clear(before?: Date): Promise<void> {
    await this.ensureInit();

    if (!before) {
      // 清空所有
      return new Promise((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } else {
      // 清空指定日期之前的日志
      const logs = await this.getAll();
      const toDelete = logs.filter(log => new Date(log.createdAt) < before);

      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      for (const log of toDelete) {
        store.delete(log.id);
      }

      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    }
  }

  /**
   * 删除单条日志
   */
  async deleteById(id: string): Promise<void> {
    await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 获取日志数量
   */
  async count(): Promise<number> {
    await this.ensureInit();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

export default WebLogStorage;
