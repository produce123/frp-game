/**
 * 错误边界组件类型定义
 */

import type { Component } from 'vue';

export interface ErrorBoundaryProps {
  /** 自定义降级组件 */
  fallback?: Component;
  /** 是否显示重试按钮，默认 true */
  retryable?: boolean;
  /** 是否显示详细错误信息 */
  showDetails?: boolean;
  /** 错误回调 */
  onError?: (error: Error, instance: any, info: string) => void;
  /** 是否在开发环境自动显示详细信息 */
  devShowDetails?: boolean;
}

export interface ErrorState {
  hasError: boolean;
  error: Error | null;
  errorInfo: string;
}
