import { invokeTool } from "../bridge.js";
import { errorResult, successResult } from "../utils.js";
import { z } from "zod";

const MapChangeOperationSchema = z.object({
	tool: z.string().describe("允许的地图写操作工具名"),
	args: z.record(z.any()).default({}).describe("工具参数"),
});

const PlanMapChangesSchema = z.object({ operations: z.array(MapChangeOperationSchema).min(1) });
const ApplyMapChangesSchema = PlanMapChangesSchema.extend({ atomic: z.boolean().default(true) });

export async function planMapChanges(args: unknown) {
	try {
		return successResult(await invokeTool("plan_map_changes", PlanMapChangesSchema.parse(args)));
	} catch (error: any) {
		return errorResult(error.message || "Failed to plan map changes");
	}
}

export async function applyMapChanges(args: unknown) {
	try {
		return successResult(await invokeTool("apply_map_changes", ApplyMapChangesSchema.parse(args)));
	} catch (error: any) {
		return errorResult(error.message || "Failed to apply map changes");
	}
}

export const mapChangeTools = [
	{
		name: "plan_map_changes",
		description: "预检批量地图写操作。仅返回允许性与执行顺序，不修改地图。",
		inputSchema: PlanMapChangesSchema,
		handler: planMapChanges,
	},
	{
		name: "apply_map_changes",
		description: "批量执行地图写操作。atomic 默认为 true，失败时回滚地图 Pinia 状态；不支持资源文件操作。",
		inputSchema: ApplyMapChangesSchema,
		handler: applyMapChanges,
	},
];