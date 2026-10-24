/**
 * 从实例中拣选可序列化的字段。
 * - 排除 Set 中指定的 key
 * - 排除函数类型值
 * - deep=true 时通过 JSON 深拷贝值（用于快照），否则浅拷贝
 */
export function pickSerializableFields(
	instance: object,
	excludeKeys: Set<string>,
	options?: { deep?: boolean },
): Record<string, any> {
	const result: Record<string, any> = {};
	for (const key of Object.keys(instance)) {
		if (excludeKeys.has(key)) continue;
		const value = (instance as any)[key];
		if (typeof value === "function") continue;
		try {
			result[key] = options?.deep ? JSON.parse(JSON.stringify(value)) : value;
		} catch {
			// 无法序列化的值（循环引用等）跳过
		}
	}
	return result;
}
