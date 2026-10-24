/**
 * MCP System Tools
 *
 * This module provides system-level tools for checking MCP connection status
 * and other system utilities.
 */

import { invokeTool } from "../bridge.js";
import { successResult, errorResult } from "../utils.js";

/**
 * Check MCP connection status
 * This tool allows AI assistants to verify they are connected to the MCP server
 */
export async function checkMCPConnection(args: unknown) {
	try {
		const result = await invokeTool("check_mcp_connection", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to check MCP connection");
	}
}

/**
 * Export tool definitions for MCP server
 */
export const systemTools = [
	{
		name: "check_mcp_connection",
		description: "检查与 MCP 服务器的连接状态。返回连接状态、服务器信息、版本号和时间戳。此工具可由 AI 助手使用以确认与地图编辑器的 MCP 连接是否正常工作。",
		inputSchema: {
			type: "object",
			properties: {},
			required: []
		},
		handler: checkMCPConnection
	}
];
