import { invokeTool } from "../bridge.js";
import { successResult, errorResult } from "../utils.js";
import { z } from "zod";

const TypeLibIdSchema = z.enum([
	"extra-libs",
	"ui-template-types",
	"game-setting-types",
	"modifier-template-types",
]);

export const ListTypeLibsSchema = z.object({});
export const GetTypeLibSchema = z.object({ typeLibId: TypeLibIdSchema.describe("类型库ID") });

export async function listTypeLibs(args: unknown) {
	try {
		return successResult(await invokeTool("list_type_libs", args));
	} catch (error: any) {
		return errorResult(error.message || "Failed to list type libraries");
	}
}

export async function getTypeLib(args: unknown) {
	try {
		return successResult(await invokeTool("get_type_lib", args));
	} catch (error: any) {
		return errorResult(error.message || "Failed to get type library");
	}
}

export const typeLibsTools = [
	{
		name: "list_type_libs",
		description: "列出可用类型库摘要（ID、名称、字符数），不返回源码。使用 get_type_lib 获取指定类型库。",
		inputSchema: ListTypeLibsSchema,
		handler: listTypeLibs,
	},
	{
		name: "get_type_lib",
		description: "按ID获取完整类型库代码。参数：typeLibId（extra-libs、ui-template-types、game-setting-types、modifier-template-types）。",
		inputSchema: GetTypeLibSchema,
		handler: getTypeLib,
	},

];