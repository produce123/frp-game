/**
 * Validators for Extra Libraries Management
 */

import { z } from "zod";

/**
 * Get extra libraries schema
 */
export const GetExtraLibsSchema = z.object({});

/**
 * Update extra libraries schema
 */
export const UpdateExtraLibsSchema = z.object({
	code: z.string().min(1, "Code is required"),
});

/**
 * Type exports
 */
export type UpdateExtraLibsInput = z.infer<typeof UpdateExtraLibsSchema>;
