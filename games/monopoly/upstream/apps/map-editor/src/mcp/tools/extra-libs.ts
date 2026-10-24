/**
 * MCP Tools for Extra Libraries Management
 *
 * This module provides CRUD operations for extra libraries through the IPC Bridge.
 * All business logic, validation, and event notifications are handled by mapContentService
 * in the renderer process via the bridge.
 */

import { invokeTool } from "../bridge.js";
import { successResult, errorResult } from "../utils.js";
import { z } from "zod";

/**
 * Simple schemas for MCP tool registration
 * Actual validation is done in Service Layer
 */
export const GetExtraLibsSchema = z.object({});
export const UpdateExtraLibsSchema = z.object({
	code: z.string(),
});

/**
 * Get extra libraries code
 */
export async function getExtraLibs(args: unknown) {
	try {
		const result = await invokeTool("get_extra_libs", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to get extra libraries");
	}
}

/**
 * Update extra libraries code
 */
export async function updateExtraLibs(args: unknown) {
	try {
		const result = await invokeTool("update_extra_libs", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to update extra libraries");
	}
}

/**
 * Export tool definitions for MCP server
 */
export const extraLibsTools = [
	{
		name: "get_extra_libs",
		description: "获取额外库代码。额外库允许您定义跨地图中所有效果代码使用的自定义函数、类型和工具。此代码在游戏阶段、事件和机会卡执行之前加载。",
		inputSchema: GetExtraLibsSchema,
		handler: getExtraLibs,
	},
	{
		name: "update_extra_libs",
		description: "更新额外库代码。使用此功能定义将在所有游戏代码（effectCode、initEventCode 等）中可用的辅助函数、自定义类型和工具函数。代码应该是有效的 TypeScript/JavaScript。常见用例：工具函数、常量、辅助类、自定义类型定义。示例：'export const PI = 3.14159; export function calculateDistance(pos1, pos2) { ... }'。需要 code（字符串）。",
		inputSchema: UpdateExtraLibsSchema,
		handler: updateExtraLibs,
	},
];
