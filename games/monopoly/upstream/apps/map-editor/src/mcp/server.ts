/**
 * MCP Server Implementation
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
// MCP服务只支持6个核心功能模块
import { chanceCardTools } from "./tools/chance-cards.js";
import { mapEventTools } from "./tools/map-events.js";
import { roleTools } from "./tools/roles.js";
import { gamePhaseTools } from "./tools/game-phases.js";
import { extraLibsTools } from "./tools/extra-libs.js";
import { typeLibsTools } from "./tools/type-libs.js";
import { resourceTools } from "./tools/resources.js";
import { mapItemTools } from "./tools/map-items.js";
import { propertyTools } from "./tools/properties.js";
import { systemTools } from "./tools/system.js";
import { gameSettingTools } from "./tools/game-settings.js";
import { uiTemplateTools } from "./tools/ui-templates.js";
import { customUITools } from "./tools/custom-uis.js";
import { modifierTemplateTools } from "./tools/modifier-templates.js";
import { validateEffectCodeTools } from "./tools/validate-effect-code.js";
import { getCodeTemplateTools } from "./tools/get-code-template.js";
import { allTools } from "./tools/registry.js";

/**
 * Convert Zod v3 schemas to complete JSON Schema objects for MCP clients.
 */
export function zodToJsonSchema(zodSchema: any): any {
	if (zodSchema && zodSchema.type === "object" && "properties" in zodSchema && !zodSchema._def) {
		return zodSchema;
	}

	const schema = convertZodSchema(zodSchema);
	return schema.type ? schema : { type: "object", properties: {} };
}

function convertZodSchema(zodSchema: any): any {
	const definition = zodSchema?._def;
	if (!definition) return {};

	const applyDescription = (schema: Record<string, any>) => {
		if (zodSchema.description) schema.description = zodSchema.description;
		return schema;
	};

	switch (definition.typeName) {
		case "ZodOptional":
		case "ZodNullable":
		case "ZodDefault":
		case "ZodCatch":
		case "ZodEffects":
			return applyDescription(convertZodSchema(definition.innerType ?? definition.schema));
		case "ZodString":
			return applyDescription({ type: "string" });
		case "ZodNumber":
			return applyDescription({ type: "number" });
		case "ZodBoolean":
			return applyDescription({ type: "boolean" });
		case "ZodLiteral":
			return applyDescription({ const: definition.value, type: typeof definition.value });
		case "ZodEnum":
			return applyDescription({ type: "string", enum: definition.values });
		case "ZodNativeEnum":
			return applyDescription({ enum: Object.values(definition.values).filter((value) => typeof value !== "number") });
		case "ZodArray":
			return applyDescription({ type: "array", items: convertZodSchema(definition.type) });
		case "ZodRecord":
			return applyDescription({ type: "object", additionalProperties: convertZodSchema(definition.valueType) });
		case "ZodUnion":
			return applyDescription({ anyOf: definition.options.map((option: any) => convertZodSchema(option)) });
		case "ZodObject": {
			const shape = typeof definition.shape === "function" ? definition.shape() : definition.shape;
			const properties: Record<string, any> = {};
			const required: string[] = [];
			for (const [key, field] of Object.entries(shape ?? {})) {
				properties[key] = convertZodSchema(field);
				if (!isOptionalSchema(field)) required.push(key);
			}
			const schema: Record<string, any> = { type: "object", properties };
			if (required.length > 0) schema.required = required;
			return applyDescription(schema);
		}
		default:
			return applyDescription({});
	}
}

function isOptionalSchema(zodSchema: any): boolean {
	const typeName = zodSchema?._def?.typeName;
	return typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodCatch";
}

/**
 * Export all tools for external access
 */
export function getAllTools() {
	return allTools;
}

/**
 * Create and configure the MCP server
 */
export function createMCPServer() {
	const server = new Server(
		{
			name: "minemonopoly-map-editor",
			version: "1.0.0",
		},
		{
			capabilities: {
				tools: {},
			},
		}
	);

	// Register list tools handler
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const tools: Tool[] = allTools.map((toolDef) => ({
			name: toolDef.name,
			description: toolDef.description,
			inputSchema: zodToJsonSchema(toolDef.inputSchema),
		}));

		return { tools };
	});

	// Register call tool handler
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;

		// Find the tool handler
		const toolDef = allTools.find((t) => t.name === name);

		if (!toolDef) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: false,
							error: `Unknown tool: ${name}`,
							errorInfo: { code: "UNKNOWN_TOOL", message: `Unknown tool: ${name}` },
						}),
					},
				],
			};
		}

		try {
			// Call the tool handler
			const result = await toolDef.handler(args);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (error: any) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: false,
								error: error.message || `Error executing tool: ${name}`,
								errorInfo: {
									code: "TOOL_EXECUTION_FAILED",
									message: error.message || `Error executing tool: ${name}`,
								},
							},
							null,
							2
						),
					},
				],
			};
		}
	});

	return server;
}

/**
 * Start the MCP server with stdio transport (legacy/standalone mode)
 */

/**
 * Start the MCP server with stdio transport (legacy/standalone mode)
 */
export async function startStdioMCPServer() {
	const server = createMCPServer();
	const transport = new StdioServerTransport();

	await server.connect(transport);

	console.error("MineMonopoly Map Editor MCP Server started (stdio)");

	return server;
}
