/**
 * MCP Tools for Game Phase Management
 *
 * This module provides CRUD operations for game phases through the IPC Bridge.
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
export const GetPhasesSchema = z.object({});
export const GetPhaseByIdSchema = z.object({
	phaseId: z.string(),
	phaseType: z.string(),
});
export const AddPhaseSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	phaseType: z.string(),
	mark: z.string().optional(),
	from: z.string(),
	initEventCode: z.string(),
});
export const RemovePhaseSchema = z.object({
	phaseId: z.string(),
	phaseType: z.string(),
});
export const UpdatePhaseSchema = z.object({
	phaseId: z.string(),
	phaseType: z.string(),
	name: z.string().optional(),
	description: z.string().optional(),
	mark: z.string().optional(),
	initEventCode: z.string().optional(),
});

/**
 * Get all game phases
 */
export async function getPhases(args: unknown) {
	try {
		const result = await invokeTool("get_phases", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to get phases");
	}
}

/**
 * Get a game phase with full details
 */
export async function getPhaseById(args: unknown) {
	try {
		const result = await invokeTool("get_phase_by_id", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to get phase");
	}
}

/**
 * Add a new game phase
 */
export async function addPhase(args: unknown) {
	try {
		const result = await invokeTool("add_phase", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to add phase");
	}
}

/**
 * Remove a game phase
 */
export async function removePhase(args: unknown) {
	try {
		const result = await invokeTool("remove_phase", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to remove phase");
	}
}

/**
 * Update a game phase
 */
export async function updatePhase(args: unknown) {
	try {
		const result = await invokeTool("update_phase", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to update phase");
	}
}

/**
 * Export tool definitions for MCP server
 */
export const gamePhaseTools = [
	{
		name: "get_phases",
		description: "获取当前地图中按类别组织的游戏阶段摘要列表，不包含 initEventCode。使用 get_phase_by_id 并传入 phaseId 和 phaseType 获取完整数据。",
		inputSchema: GetPhasesSchema,
		handler: getPhases,
	},
	{
		name: "get_phase_by_id",
		description: "根据ID和阶段类别获取单个游戏阶段的完整信息，包含 initEventCode。参数：phaseId、phaseType。",
		inputSchema: GetPhaseByIdSchema,
		handler: getPhaseById,
	},
	{
		name: "add_phase",
		description:
			"添加新的游戏阶段。游戏阶段被组织到不同类别中：gameOverRule（游戏结束检查）、gameInited（一次性初始化）、gameRoundStart（每回合开始）、playerRound（玩家回合）、gameRoundEnd（每回合结束）、postRestore（存档恢复后执行，仅在有存档数据时运行一次）。每个阶段都有一个 initEventCode 在阶段执行时运行。重要提示：initEventCode 必须返回一个接受 (ctx: GameContext, gameProcess: IGameProcess) 参数的异步函数。ctx 类型因阶段标记而异。常见的上下文类型包括：GameRoundStartContext、PlayerRoundContext（包含 currentRoundPlayer）。需要 id、name、description、phaseType（类别）、from 和 initEventCode。mark 可选。",
		inputSchema: AddPhaseSchema,
		handler: addPhase,
	},
	{
		name: "remove_phase",
		description: "根据ID删除游戏阶段。需要 phaseId 和 phaseType（阶段所属的类别：gameOverRule、gameInited、gameRoundStart、playerRound、gameRoundEnd、postRestore）。",
		inputSchema: RemovePhaseSchema,
		handler: removePhase,
	},
	{
		name: "update_phase",
		description: "更新现有游戏阶段。需要 phaseId 和 phaseType。只提供需要更新的字段（name、description、mark、initEventCode）。",
		inputSchema: UpdatePhaseSchema,
		handler: updatePhase,
	},
];
