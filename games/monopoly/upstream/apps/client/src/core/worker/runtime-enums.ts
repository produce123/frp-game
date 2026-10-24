/**
 * 运行时枚举
 * 从 editor-lib.d.ts 自动提取并转换为运行时可用的对象
 *
 * editor-lib.d.ts 是自动生成的类型定义文件，包含最新的枚举定义
 * 此模块解析该文件并提取所有 declare enum，转换为普通对象供运行时使用
 */

import editorLibDeclaration from "./editor-lib.d.ts?raw";

/**
 * 从 editor-lib.d.ts 内容中提取枚举定义
 * 支持格式：
 * - declare enum EnumName { ... }
 * - declare const enum EnumName { ... }
 */
function extractEnumsFromDTS(dtsContent: string): Record<string, Record<string, string | number>> {
	const enums: Record<string, Record<string, string | number>> = {};

	// 匹配 declare enum 或 declare const enum
	const enumRegex = /declare\s+(?:const\s+)?enum\s+(\w+)\s*\{([^}]+)\}/g;
	let match;

	while ((match = enumRegex.exec(dtsContent)) !== null) {
		const [, enumName, enumBody] = match;
		const enumValues: Record<string, string | number> = {};

		// 解析枚举成员
		const memberRegex = /(\w+)\s*=\s*([^,\n]+)(?:,\s*)?/g;
		let memberMatch;

		while ((memberMatch = memberRegex.exec(enumBody)) !== null) {
			const [, memberName, memberValue] = memberMatch;
			// 移除注释和多余空格
			let cleanedValue = memberValue.trim().replace(/\/\/.*$/, "").trim();

			// 如果是字符串值（带引号），提取字符串内容
			if ((cleanedValue.startsWith('"') && cleanedValue.endsWith('"')) ||
				(cleanedValue.startsWith("'") && cleanedValue.endsWith("'"))) {
				enumValues[memberName] = cleanedValue.slice(1, -1);
			} else if (!isNaN(Number(cleanedValue))) {
				// 如果是数字，转换为数值
				enumValues[memberName] = Number(cleanedValue);
			} else {
				// 其他情况（如 true/false/undefined），转换为字符串
				enumValues[memberName] = cleanedValue;
			}
		}

		// 如果没有显式值成员，尝试解析简单枚举（如：MemberName,）
		if (Object.keys(enumValues).length === 0) {
			const lines = enumBody.split(',').map(l => l.trim());
			for (const line of lines) {
				if (line && !line.startsWith('//')) {
					const memberName = line.split(/\s+/)[0];
					if (memberName && memberName !== 'enum') {
						enumValues[memberName] = memberName;
					}
				}
			}
		}

		if (Object.keys(enumValues).length > 0) {
			enums[enumName] = enumValues;
		}
	}

	return enums;
}

// 自动提取所有枚举
export const allRuntimeEnums = extractEnumsFromDTS(editorLibDeclaration);

// 重新导出各个枚举（保持向后兼容）
export const TargetSelectType = allRuntimeEnums.TargetSelectType || {};
export const MapEventType = allRuntimeEnums.MapEventType || {};
export const GameLinkItem = allRuntimeEnums.GameLinkItem || {};
export const GamePhaseMark = allRuntimeEnums.GamePhaseMark || {};
export const OperateType = allRuntimeEnums.OperateType || {};
export const SocketMsgType = allRuntimeEnums.SocketMsgType || {};
export const SocketMsgSource = allRuntimeEnums.SocketMsgSource || {};
export const ChatMessageType = allRuntimeEnums.ChatMessageType || {};
export const MoneyTag = allRuntimeEnums.MoneyTag || {};
