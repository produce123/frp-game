import type { PlatformType } from "../platform/types";

export type Platform = "web" | "PC" | "mobile";

const cachedPlatformType: { value: PlatformType | null } = { value: null };

/**
 * 获取当前运行时平台类型
 */
export const getPlatformType = (): PlatformType => {
	if (cachedPlatformType.value) return cachedPlatformType.value;

	let type: PlatformType;

	// 检测顺序：Capacitor → Electron → 移动端浏览器 → Web
	if (typeof (window as any).Capacitor !== "undefined" && (window as any).Capacitor?.isNativePlatform?.()) {
		type = "capacitor";
	} else if (typeof (window as any).electronAPI !== "undefined") {
		type = "electron";
	} else if (/android|iphone|ipad|ipod/i.test(navigator.userAgent)) {
		type = "mobile";
	} else {
		type = "web";
	}

	cachedPlatformType.value = type;
	return type;
};

// ========== 保留的旧版兼容函数 ==========

/** @deprecated 请使用 getPlatformType() */
export const getPlatform = (): Platform => {
	const t = getPlatformType();
	if (t === "electron") return "PC";
	if (t === "capacitor" || t === "mobile") return "mobile";
	return "web";
};

/** @deprecated 请使用 getPlatformType() */
export const isWeb = () => getPlatformType() === "web";

/** @deprecated 请使用 getPlatformType() === 'electron' */
export const isPC = () => getPlatformType() === "electron";

/** @deprecated 请使用 getPlatformType() === 'capacitor' || PlatformType === 'mobile' */
export const isMobile = () => {
	const t = getPlatformType();
	return t === "capacitor" || t === "mobile";
};
