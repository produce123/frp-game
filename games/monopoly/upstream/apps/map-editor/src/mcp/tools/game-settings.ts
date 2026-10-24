/**
 * MCP Tools for Game Settings Management
 *
 * This module provides CRUD operations for game setting form fields through the IPC Bridge.
 * All business logic, validation, and event notifications are handled by mapContentService
 * in the renderer process via the bridge.
 */

import { invokeTool } from "../bridge.js";
import { successResult, errorResult } from "../utils.js";
import { z } from "zod";

const SelectOptionSchema = z.object({
	label: z.string().describe("选项标签"),
	value: z.union([z.string(), z.number()]).describe("选项值"),
});

const AddGameSettingToolSchema = z.object({
	key: z.string().describe("字段标识符，如 'initMoney'"),
	type: z.enum(["number-input", "select"]).describe("组件类型"),
	label: z.string().describe("显示标签"),
	defaultValue: z.union([z.string(), z.number()]).optional().describe("默认值"),
	min: z.number().optional().describe("最小值（number-input 专用）"),
	max: z.number().optional().describe("最大值（number-input 专用）"),
	placeholder: z.string().optional().describe("占位符文本"),
	options: z.array(SelectOptionSchema).optional().describe("下拉选项（select 专用）"),
});

const UpdateGameSettingToolSchema = z.object({
	id: z.string().describe("游戏参数ID"),
	key: z.string().optional().describe("字段标识符"),
	type: z.enum(["number-input", "select"]).optional().describe("组件类型"),
	label: z.string().optional().describe("显示标签"),
	defaultValue: z.union([z.string(), z.number()]).optional().describe("默认值"),
	min: z.number().optional().describe("最小值"),
	max: z.number().optional().describe("最大值"),
	placeholder: z.string().optional().describe("占位符文本"),
	options: z.array(SelectOptionSchema).optional().describe("下拉选项"),
});

const RemoveGameSettingToolSchema = z.object({
	settingId: z.string().describe("游戏参数ID"),
});

const GetGameSettingToolSchema = z.object({
	settingId: z.string().describe("游戏参数ID"),
});

const ListGameSettingsToolSchema = z.object({});

/**
 * Add a new game setting field
 */
export async function addGameSetting(args: unknown) {
	try {
		const result = await invokeTool("add_game_setting", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to add game setting");
	}
}

/**
 * Update an existing game setting field
 */
export async function updateGameSetting(args: unknown) {
	try {
		const result = await invokeTool("update_game_setting", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to update game setting");
	}
}

/**
 * Remove a game setting field
 */
export async function removeGameSetting(args: unknown) {
	try {
		const result = await invokeTool("remove_game_setting", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to remove game setting");
	}
}

/**
 * Get a single game setting field
 */
export async function getGameSetting(args: unknown) {
	try {
		const result = await invokeTool("get_game_setting", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to get game setting");
	}
}

/**
 * List all game setting fields
 */
export async function listGameSettings(args: unknown) {
	try {
		const result = await invokeTool("list_game_settings", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to list game settings");
	}
}

/**
 * Export tool definitions for MCP server
 */
export const gameSettingTools = [
	{
		name: "get_game_setting",
		description: "根据ID获取单个游戏参数字段完整信息。参数：settingId（游戏参数ID）。",
		inputSchema: GetGameSettingToolSchema,
		handler: getGameSetting,
	},
	{
		name: "list_game_settings",
		description: "列出当前地图中所有游戏参数字段。返回每个字段的 id、key、type、label、defaultValue、min、max、placeholder、options 等信息。",
		inputSchema: ListGameSettingsToolSchema,
		handler: listGameSettings
	},
	{
		name: "add_game_setting",
		description: "添加新的游戏参数字段。参数:key(字段标识符如initMoney), type(number-input/select), label(显示标签), defaultValue?(默认值), min?(最小值), max?(最大值), placeholder?(占位符), options?(下拉选项数组)",
		inputSchema: AddGameSettingToolSchema,
		handler: addGameSetting
	},
	{
		name: "update_game_setting",
		description: "更新游戏参数字段。参数:id(游戏参数ID), 其余字段均可选:key, type, label, defaultValue, min, max, placeholder, options",
		inputSchema: UpdateGameSettingToolSchema,
		handler: updateGameSetting
	},
	{
		name: "remove_game_setting",
		description: "删除游戏参数字段。参数:settingId(游戏参数ID)",
		inputSchema: RemoveGameSettingToolSchema,
		handler: removeGameSetting
	}
];
