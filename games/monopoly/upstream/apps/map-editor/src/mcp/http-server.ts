/**
 * HTTP MCP Server Implementation
 *
 * This file implements a Streamable HTTP transport for the MCP server.
 * It uses the official SDK's StreamableHTTPServerTransport.
 */

import express, { type Request, Response } from "express";
import { createServer, type Server as HttpServer } from "http";
import { createMCPServer } from "./server.js";

export interface HTTPMCPServer {
	close: () => Promise<void>;
	port: number;
	url: string;
}

export interface ServerConfig {
	port: number;
	host?: string; // 默认 '127.0.0.1'
	onReady?: (info: { port: number; url: string }) => void;
	onError?: (error: Error) => void;
}

/**
 * 检查端口是否可用
 */
function isPortAvailable(port: number, host: string): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();

		server.once("error", () => {
			resolve(false);
		});

		server.once("listening", () => {
			server.close();
			resolve(true);
		});

		server.listen(port, host);
	});
}

/**
 * 查找可用端口
 */
async function findAvailablePort(startPort: number, host: string, maxAttempts = 20): Promise<number> {
	for (let i = 0; i < maxAttempts; i++) {
		const port = startPort + i;
		if (await isPortAvailable(port, host)) {
			return port;
		}
	}
	throw new Error(`No available ports found from ${startPort} to ${startPort + maxAttempts - 1}`);
}

/**
 * 启动 HTTP MCP 服务器
 */
export async function startHTTPMCPServer(config: ServerConfig): Promise<HTTPMCPServer> {
	console.log("[HTTP MCP] startHTTPMCPServer called with config:", config);
	const { port: requestedPort, host = "127.0.0.1", onReady, onError } = config;

	// 查找可用端口
	console.log("[HTTP MCP] Finding available port starting from:", requestedPort);
	const port = await findAvailablePort(requestedPort, host);
	const url = `http://${host}:${port}/mcp`;
	console.log("[HTTP MCP] Available port found:", port, "URL:", url);

	// 动态导入 StreamableHTTPServerTransport 和 createMcpExpressApp
	const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
	const { createMcpExpressApp } = await import("@modelcontextprotocol/sdk/server/express.js");

	// 创建 Express 应用（已经内置了 JSON 解析和 CORS）
	const app = createMcpExpressApp({ host });

	// 处理 MCP POST 请求
	app.post("/mcp", async (req: Request, res: Response) => {
		console.log("[HTTP MCP] Received POST request to /mcp");

		try {
			// 为每个请求创建新的服务器实例和 transport
			const server = createMCPServer();
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});

			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);

			// 清理
			res.on("close", () => {
				console.log("[HTTP MCP] Request closed, cleaning up");
				transport.close();
				server.close();
			});
		} catch (error: any) {
			console.error("[HTTP MCP] Error handling MCP request:", error);

			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: "2.0",
					error: {
						code: -32603,
						message: "Internal server error",
						data: error.message,
					},
					id: null,
				});
			}
		}
	});

	// 处理 MCP GET 请求 - 返回 405
	app.get("/mcp", (req: Request, res: Response) => {
		console.log("[HTTP MCP] Received GET request to /mcp");
		res.status(405).json({
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: "Method not allowed",
			},
			id: null,
		});
	});

	// 处理 DELETE 请求 - 返回 405
	app.delete("/mcp", (req: Request, res: Response) => {
		console.log("[HTTP MCP] Received DELETE request to /mcp");
		res.status(405).json({
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: "Method not allowed",
			},
			id: null,
		});
	});

	// 启动 HTTP 服务器
	console.log("[HTTP MCP] About to listen on", host, "port", port);

	return new Promise<HTTPMCPServer>((resolve, reject) => {
		const httpServer: HttpServer = app.listen(port, host, () => {
			console.log(`[HTTP MCP] MCP HTTP Server started on ${url}`);
			onReady?.({ port, url });

			const serverObj: HTTPMCPServer = {
				close: async () => {
					console.log("[HTTP MCP] Closing server");
					return new Promise<void>((resolveClose, rejectClose) => {
						httpServer.close((err) => {
							if (err) rejectClose(err);
							else resolveClose();
						});
					});
				},
				port,
				url,
			};

			console.log("[HTTP MCP] Resolving with server object:", serverObj);
			resolve(serverObj);
		});

		httpServer.on("error", (error: any) => {
			console.error("[HTTP MCP] HTTP Server error:", error);
			onError?.(error);
			reject(error);
		});
	});
}
