/**
 * MCP Server Types for MineMonopoly Map Editor
 */

// Re-export types from @mine-monopoly/types for use in MCP tools
export type { MapItem, MapEvent, Role, GameMapInfo } from "@mine-monopoly/types";

/**
 * ResourcesType from the store
 */
export interface ResourcesType {
	id: string;
	name: string;
	fileType: string;
	url: string;
}

/**
 * MCP Tool result type
 */
export interface MCPToolResult {
	success: boolean;
	data?: any;
	error?: string;
}

/**
 * Map summary statistics
 */
export interface MapSummary {
	totalItems: number;
	totalEvents: number;
	totalRoles: number;
	totalModels: number;
	totalImages: number;
	mapIndexLength: number;
}

/**
 * Coordinates filter for map items
 */
export interface CoordinateFilter {
	x?: number;
	y?: number;
	radius?: number;
}

/**
 * Input validation schemas for MCP tools
 */
export interface AddMapItemInput {
	typeId: string;
	x: number;
	y: number;
	rotation?: number;
	mapEventId?: string;
}

export interface UpdateMapItemInput {
	itemId: string;
	x?: number;
	y?: number;
	rotation?: number;
}

export interface LinkMapItemsInput {
	sourceId: string;
	targetId: string;
}

export interface AddMapEventInput {
	name: string;
	type: string;
	description: string;
	iconId: string;
	effectCode: string;
}

export interface AddRoleInput {
	name: string;
	imageId: string;
}

export interface ValidateMapInput {
	checkLevel: "basic" | "strict";
}

export interface ValidationError {
	type: "error" | "warning";
	message: string;
	location?: string;
}

export interface ValidationResult {
	errors: ValidationError[];
	warnings: ValidationError[];
	isValid: boolean;
}

/**
 * Duplicate coordinate result
 */
export interface DuplicateCoordinate {
	x: number;
	y: number;
	items: string[];
}

/**
 * Map layout analysis result
 */
export interface MapLayoutAnalysis {
	bounds: {
		minX: number;
		maxX: number;
		minY: number;
		maxY: number;
	};
	emptySpots: Array<{ x: number; y: number }>;
	clusters: Array<Array<{ x: number; y: number }>>;
}
