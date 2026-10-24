/**
 * ModifierTemplate Validator
 *
 * Zod schemas for validating modifier template data structures.
 * This ensures data integrity for both UI forms and MCP operations.
 */

import { z } from "zod";

export const AddModifierTemplateSchema = z.object({
	name: z.string().min(1, "名称不能为空"),
	slug: z
		.string()
		.min(1, "slug 不能为空")
		.regex(/^[a-zA-Z0-9_-]+$/, "slug 只能包含字母、数字、下划线和连字符"),
	descriptor: z.object({
		timing: z.enum(["before", "after"]),
		commandType: z.string().min(1),
		remainingTriggers: z.number(),
		priority: z.number().default(0),
		autoConsume: z.boolean().default(true),
		meta: z
			.object({
				name: z.string(),
				description: z.string(),
			})
			.optional(),
	}),
	effectCode: z.string().min(1, "effectCode 不能为空"),
});

export const UpdateModifierTemplateSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	slug: z.string().optional(),
	descriptor: z.any().optional(),
	effectCode: z.string().optional(),
});

export type ModifierTemplateData = z.infer<typeof AddModifierTemplateSchema>;
