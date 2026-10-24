/**
 * MCP Tools for ModifierTemplate Management
 *
 * CRUD operations for modifier templates through the IPC Bridge.
 * All business logic is handled by mapContentService in the renderer process.
 */

import { invokeTool } from "../bridge.js";
import { successResult, errorResult } from "../utils.js";
import { z } from "zod";

const CreateModifierTemplateToolSchema = z.object({
	name: z.string().describe("模板名称"),
	slug: z.string().describe("模板别名（用于类型声明，需唯一）"),
	descriptor: z.object({
		timing: z.string().describe("触发时机"),
		commandType: z.string().describe("命令类型"),
		remainingTriggers: z.number().describe("剩余触发次数"),
		priority: z.number().describe("优先级"),
		autoConsume: z.boolean().describe("是否自动消耗"),
		meta: z.record(z.any()).describe("元数据"),
	}).describe("修饰器描述符"),
	effectCode: z.string().describe("效果代码"),
});

const UpdateModifierTemplateToolSchema = z.object({
	id: z.string().describe("模板ID"),
	name: z.string().optional().describe("模板名称"),
	slug: z.string().optional().describe("模板别名"),
	descriptor: z.object({
		timing: z.string().describe("触发时机"),
		commandType: z.string().describe("命令类型"),
		remainingTriggers: z.number().describe("剩余触发次数"),
		priority: z.number().describe("优先级"),
		autoConsume: z.boolean().describe("是否自动消耗"),
		meta: z.record(z.any()).describe("元数据"),
	}).optional().describe("修饰器描述符"),
	effectCode: z.string().optional().describe("效果代码"),
});

const RemoveModifierTemplateToolSchema = z.object({
	templateId: z.string().describe("模板ID"),
});

const GetModifierTemplateToolSchema = z.object({
	templateId: z.string().describe("模板ID"),
});

const ListModifierTemplatesToolSchema = z.object({});

export async function createModifierTemplate(args: unknown) {
	try {
		const result = await invokeTool("create_modifier_template", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to create modifier template");
	}
}

export async function updateModifierTemplate(args: unknown) {
	try {
		const result = await invokeTool("update_modifier_template", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to update modifier template");
	}
}

export async function removeModifierTemplate(args: unknown) {
	try {
		const result = await invokeTool("remove_modifier_template", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to remove modifier template");
	}
}

export async function getModifierTemplate(args: unknown) {
	try {
		const result = await invokeTool("get_modifier_template", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to get modifier template");
	}
}

export async function listModifierTemplates(args: unknown) {
	try {
		const result = await invokeTool("list_modifier_templates", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to list modifier templates");
	}
}

export const modifierTemplateTools = [
	{
		name: "create_modifier_template",
		description: "创建新的修饰器模板。参数：name（模板名称）, slug（模板别名，用于类型声明）, descriptor（修饰器描述符，包含 timing, commandType, remainingTriggers, priority, autoConsume, meta）, effectCode（效果代码）",
		inputSchema: CreateModifierTemplateToolSchema,
		handler: createModifierTemplate,
	},
	{
		name: "update_modifier_template",
		description: "更新修饰器模板。参数：id（模板ID），其余字段可选。支持更新：name, slug, descriptor, effectCode",
		inputSchema: UpdateModifierTemplateToolSchema,
		handler: updateModifierTemplate,
	},
	{
		name: "remove_modifier_template",
		description: "删除修饰器模板。参数：templateId（模板ID）",
		inputSchema: RemoveModifierTemplateToolSchema,
		handler: removeModifierTemplate,
	},
	{
		name: "get_modifier_template",
		description: "获取单个修饰器模板详情。参数：templateId（模板ID）",
		inputSchema: GetModifierTemplateToolSchema,
		handler: getModifierTemplate,
	},
	{
		name: "list_modifier_templates",
		description: "列出所有修饰器模板的摘要信息，不包含 effectCode。使用 get_modifier_template 并传入 templateId 获取完整数据。",
		inputSchema: ListModifierTemplatesToolSchema,
		handler: listModifierTemplates,
	},
];
