/**
 * 错误记录辅助工具
 * 提供增强的错误记录功能，自动捕获调用栈和上下文信息
 */

import logService, { ErrorCategory } from './index';

export interface LogErrorOptions {
	/** 错误分类 */
	category: ErrorCategory;
	/** 错误类型（用于兼容旧版） */
	type?: string;
	/** 错误消息 */
	message: string;
	/** 原始错误对象（自动提取调用栈） */
	error?: Error;
	/** 额外信息 */
	extraInfo?: Record<string, any>;
	/** 上下文信息 */
	context?: Record<string, any>;
}

/**
 * 增强的错误记录函数
 * 自动捕获调用栈和完整上下文
 */
export function logErrorWithOptions(options: LogErrorOptions): void {
	// 如果没有提供错误对象，创建一个新的 Error 来获取当前调用栈
	const stack = options.error?.stack || (() => {
		const err = new Error();
		// 移除当前函数的调用栈帧
		if (err.stack) {
			const lines = err.stack.split('\n');
			// 移除 "Error:" 行和当前函数的调用行（前两行）
			return lines.slice(2).join('\n');
		}
		return undefined;
	})();

	logService.error({
		category: options.category,
		type: options.type as any,
		message: options.message,
		stack: stack,
		info: options.extraInfo ? JSON.stringify(options.extraInfo, null, 2) : undefined,
		context: options.context,
	});
}

/**
 * 从 Error 对象创建详细错误日志
 */
export function logError(error: Error, options: {
	category: ErrorCategory;
	type?: string;
	context?: Record<string, any>;
	extraInfo?: Record<string, any>;
}): void {
	logErrorWithOptions({
		category: options.category,
		type: options.type,
		message: error.message,
		error: error,
		extraInfo: options.extraInfo,
		context: options.context,
	});
}

/**
 * 记录带有完整上下文的 Worker 错误
 */
export function logWorkerError(options: {
	message: string;
	type?: string;
	error?: Error;
	workerState?: string;
	extraInfo?: Record<string, any>;
}): void {
	logErrorWithOptions({
		category: ErrorCategory.WORKER,
		type: options.type,
		message: options.message,
		error: options.error,
		extraInfo: {
			workerState: options.workerState,
			...options.extraInfo,
		},
	});
}

/**
 * 记录组件验证错误
 */
export function logValidationError(options: {
	componentType: string;
	componentName: string;
	errorMessage: string;
	errorStack?: string;
	userId?: string;
}): void {
	logErrorWithOptions({
		category: ErrorCategory.COMPONENT_VALIDATION,
		type: options.componentType,
		message: `${options.componentType}「${options.componentName}」验证失败: ${options.errorMessage}`,
		error: options.errorStack ? { message: options.errorMessage, stack: options.errorStack } as Error : undefined,
		extraInfo: {
			componentType: options.componentType,
			componentName: options.componentName,
			userId: options.userId,
		},
	});
}
