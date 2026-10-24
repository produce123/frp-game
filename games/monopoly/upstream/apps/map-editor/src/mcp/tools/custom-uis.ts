/**
 * MCP Tools for CustomUI Management
 *
 * CRUD operations for custom UI instances through the IPC Bridge.
 * All business logic is handled by mapContentService in the renderer process.
 *
 * Note: CustomUI.uiSchema 字段存储的是 UITemplate.id（模板引用），而非实际的 schema JSON。
 */

import { invokeTool } from "../bridge.js";
import { successResult, errorResult } from "../utils.js";
import { z } from "zod";

const CreateCustomUIToolSchema = z.object({
	name: z.string().describe("实例名称"),
	uiSchema: z.string().describe("引用的 UITemplate ID"),
	layout: z.object({
		x: z.number().describe("X 坐标"),
		y: z.number().describe("Y 坐标"),
		width: z.number().describe("宽度"),
		height: z.number().describe("高度"),
	}).describe("布局信息"),
});

const UpdateCustomUIToolSchema = z.object({
	id: z.string().describe("实例ID"),
	name: z.string().optional().describe("实例名称"),
	uiSchema: z.string().optional().describe("引用的 UITemplate ID（更换模板）"),
	layout: z.object({
		x: z.number().optional().describe("X 坐标"),
		y: z.number().optional().describe("Y 坐标"),
		width: z.number().optional().describe("宽度"),
		height: z.number().optional().describe("高度"),
	}).optional().describe("布局信息"),
});

const RemoveCustomUIToolSchema = z.object({
	instanceId: z.string().describe("实例ID"),
});

const GetCustomUIToolSchema = z.object({
	instanceId: z.string().describe("实例ID"),
});

const ListCustomUIToolSchema = z.object({});

export async function createCustomUI(args: unknown) {
	try {
		const result = await invokeTool("create_custom_ui", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to create custom UI");
	}
}

export async function updateCustomUI(args: unknown) {
	try {
		const result = await invokeTool("update_custom_ui", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to update custom UI");
	}
}

export async function removeCustomUI(args: unknown) {
	try {
		const result = await invokeTool("remove_custom_ui", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to remove custom UI");
	}
}

export async function getCustomUI(args: unknown) {
	try {
		const result = await invokeTool("get_custom_ui", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to get custom UI");
	}
}

export async function listCustomUIs(args: unknown) {
	try {
		const result = await invokeTool("list_custom_uis", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to list custom UIs");
	}
}

export const customUITools = [
	{
		name: "create_custom_ui",
		description: "创建新的自定义 UI 实例。参数：name（实例名称）, uiSchema（引用的 UITemplate ID）, layout（布局：x, y, width, height）",
		inputSchema: CreateCustomUIToolSchema,
		handler: createCustomUI,
	},
	{
		name: "update_custom_ui",
		description: "更新自定义 UI 实例。参数：id（实例ID），其余字段可选。支持更新：name, uiSchema（更换引用模板）, layout（部分更新坐标/尺寸）",
		inputSchema: UpdateCustomUIToolSchema,
		handler: updateCustomUI,
	},
	{
		name: "remove_custom_ui",
		description: "删除自定义 UI 实例。参数：instanceId（实例ID）",
		inputSchema: RemoveCustomUIToolSchema,
		handler: removeCustomUI,
	},
	{
		name: "get_custom_ui",
		description: "获取单个自定义 UI 实例详情。参数：instanceId（实例ID）",
		inputSchema: GetCustomUIToolSchema,
		handler: getCustomUI,
	},
	{
		name: "list_custom_uis",
		description: "列出所有自定义 UI 实例。无参数。",
		inputSchema: ListCustomUIToolSchema,
		handler: listCustomUIs,
	},
];
