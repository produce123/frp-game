/**
 * 统一日志服务
 * 提供跨平台的日志记录、查询、导出、删除功能
 */

import type {
  ILogService,
  LogErrorData,
  LogFilter,
  LogExportFormat,
  ErrorContext
} from './types';
import { ErrorLevel, ErrorCategory } from './types';

import { getPlatformType } from "@src/utils/platform";

// 动态导入存储适配器
let storageInstance: any = null;

async function getStorage() {
  if (!storageInstance) {
    const isElectron = getPlatformType() === "electron";
    if (isElectron) {
      const module = await import('./storage-electron');
      storageInstance = new module.ElectronLogStorage();
    } else {
      const module = await import('./storage-web');
      storageInstance = new module.WebLogStorage();
    }
  }
  return storageInstance;
}

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * 获取本地时区的 ISO 时间字符串
 */
function toLocalISOString(date: Date): string {
  const offset = date.getTimezoneOffset() * -1;
  const offsetHours = Math.abs(Math.floor(offset / 60));
  const offsetMinutes = Math.abs(offset % 60);
  const offsetSign = offset >= 0 ? '+' : '-';
  const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${offsetStr}`;
}

/**
 * 创建默认错误上下文
 */
function createDefaultContext(): ErrorContext {
  return {
    timestamp: toLocalISOString(new Date()),
    url: window.location.pathname,
    userAgent: navigator.userAgent.substring(0, 200),
    screenInfo: `${screen.width}x${screen.height}`,
    memoryUsage: performance?.memory ? {
      usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + ' MB',
      totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024) + ' MB'
    } : undefined
  };
}

/**
 * 日志服务实现
 */
class LogService implements ILogService {
  /**
   * 记录错误日志
   */
  async error(data: Omit<LogErrorData, 'id' | 'level' | 'context' | 'createdAt'> & {
    level?: ErrorLevel;
    context?: Partial<ErrorContext>;
  }): Promise<void> {
    const storage = await getStorage();
    const log: LogErrorData = {
      id: generateId(),
      level: data.level || ErrorLevel.ERROR,
      category: data.category || ErrorCategory.UNKNOWN,
      type: data.type,
      message: data.message,
      stack: data.stack,
      info: data.info,
      filename: data.filename,
      lineno: data.lineno,
      colno: data.colno,
      context: {
        ...createDefaultContext(),
        ...data.context
      },
      createdAt: toLocalISOString(new Date())
    };

    // 同时发送到 Electron（如果可用）
    if (window.platformAPI?.logError) {
      window.platformAPI.logError({
        type: log.type || 'Runtime',
        message: log.message,
        stack: log.stack,
        info: log.info,
        filename: log.filename,
        lineno: log.lineno,
        colno: log.colno,
        timestamp: log.createdAt,
        additionalData: log.context as any
      });
    }

    await storage.add(log);
  }

  /**
   * 记录警告日志
   */
  async warn(data: Omit<LogErrorData, 'id' | 'level' | 'context' | 'createdAt'> & {
    level?: ErrorLevel;
    context?: Partial<ErrorContext>;
  }): Promise<void> {
    // warn 级别不写入持久存储
  }

  /**
   * 记录信息日志
   */
  async info(data: Omit<LogErrorData, 'id' | 'level' | 'context' | 'createdAt'> & {
    level?: ErrorLevel;
    context?: Partial<ErrorContext>;
  }): Promise<void> {
    // info 级别不写入持久存储
  }

  /**
   * 根据筛选条件获取日志
   */
  async getLogs(filter?: LogFilter): Promise<LogErrorData[]> {
    const storage = await getStorage();
    let logs = await storage.get(filter);
    // 按时间倒序排列
    return logs.sort((a: LogErrorData, b: LogErrorData) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * 导出日志
   */
  async export(format: LogExportFormat): Promise<Blob> {
    const logs = await this.getLogs();

    if (format === 'json') {
      const json = JSON.stringify(logs, null, 2);
      return new Blob([json], { type: 'application/json' });
    } else {
      // TXT 格式
      const lines = logs.map(log => {
        const levelIcon = {
          fatal: '[致命]',
          error: '[错误]',
          warning: '[警告]',
          info: '[信息]'
        }[log.level];

        const categoryIcon = {
          network: '[网络]',
          game: '[游戏]',
          render: '[渲染]',
          worker: '[Worker]',
          auth: '[认证]',
          component_validation: '[组件验证]',
          game_runtime: '[运行时]',
          init_timeout: '[初始化超时]',
          unknown: '[未知]'
        }[log.category];

        let line = `${log.createdAt} ${levelIcon} ${categoryIcon} ${log.message}`;

        if (log.stack) {
          line += `\n堆栈: ${log.stack}`;
        }

        if (log.context && Object.keys(log.context).length > 0) {
          line += `\n上下文: ${JSON.stringify(log.context, null, 2)}`;
        }

        return line + '\n' + '-'.repeat(80);
      }).join('\n\n');

      return new Blob([lines], { type: 'text/plain;charset=utf-8' });
    }
  }

  /**
   * 清空日志
   */
  async clear(before?: Date): Promise<void> {
    const storage = await getStorage();
    await storage.clear(before);
  }

  /**
   * 删除单条日志
   */
  async deleteById(id: string): Promise<void> {
    const storage = await getStorage();
    await storage.deleteById(id);
  }

  /**
   * 获取日志数量
   */
  async count(): Promise<number> {
    const storage = await getStorage();
    return await storage.count();
  }
}

// 单例实例
const logService = new LogService();

export default logService;
export { LogService, type ILogService };
export * from './types';
export * from './error-helpers';
