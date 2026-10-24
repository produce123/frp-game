/**
 * MCP Tools for UITemplate Management
 *
 * CRUD operations for UI templates through the IPC Bridge.
 * All business logic is handled by mapContentService in the renderer process.
 */

import { invokeTool } from "../bridge.js";
import { successResult, errorResult } from "../utils.js";
import { z } from "zod";

const CreateUITemplateToolSchema = z.object({
	name: z.string().describe("模板名称"),
	slug: z.string().describe("模板别名（用于类型声明 $ui__{slug}，需唯一）"),
	template: z.record(z.any()).describe("UISchema JSON 对象，描述模板的 UI 结构"),
});

const UpdateUITemplateToolSchema = z.object({
	id: z.string().describe("模板ID"),
	name: z.string().optional().describe("模板名称"),
	slug: z.string().optional().describe("模板别名"),
	template: z.record(z.any()).optional().describe("UISchema JSON 对象"),
});

const RemoveUITemplateToolSchema = z.object({
	templateId: z.string().describe("模板ID"),
});

const GetUITemplateToolSchema = z.object({
	templateId: z.string().describe("模板ID"),
});

const ListUITemplatesToolSchema = z.object({});

export async function createUITemplate(args: unknown) {
	try {
		const result = await invokeTool("create_ui_template", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to create UI template");
	}
}

export async function updateUITemplate(args: unknown) {
	try {
		const result = await invokeTool("update_ui_template", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to update UI template");
	}
}

export async function removeUITemplate(args: unknown) {
	try {
		const result = await invokeTool("remove_ui_template", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to remove UI template");
	}
}

export async function getUITemplate(args: unknown) {
	try {
		const result = await invokeTool("get_ui_template", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to get UI template");
	}
}

export async function listUITemplates(args: unknown) {
	try {
		const result = await invokeTool("list_ui_templates", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to list UI templates");
	}
}

export const uiTemplateTools = [
	{
		name: "create_ui_template",
		description: "创建新的 UI 模板。参数：name（模板名称）, slug（模板别名，用于类型声明 $ui__{slug}）, template（UISchema JSON 对象，描述模板的 UI 结构）",
		inputSchema: CreateUITemplateToolSchema,
		handler: createUITemplate,
	},
	{
		name: "update_ui_template",
		description: "更新 UI 模板。参数：id（模板ID），其余字段可选。支持更新：name, slug, template",
		inputSchema: UpdateUITemplateToolSchema,
		handler: updateUITemplate,
	},
	{
		name: "remove_ui_template",
		description: "删除 UI 模板。如果模板被 CustomUI 实例引用则拒绝删除。参数：templateId（模板ID）",
		inputSchema: RemoveUITemplateToolSchema,
		handler: removeUITemplate,
	},
	{
		name: "get_ui_template",
		description: "获取单个 UI 模板详情。参数：templateId（模板ID）",
		inputSchema: GetUITemplateToolSchema,
		handler: getUITemplate,
	},
	{
		name: "list_ui_templates",
		description: "列出所有 UI 模板。无参数。",
		inputSchema: ListUITemplatesToolSchema,
		handler: listUITemplates,
	},
];
