import router from "@src/router";
import { useUserInfo, useRoomInfo } from "@src/store";
import { destoryMonopolyClient } from "@src/core/monopoly-client/MonopolyClient";

function safeLocalStorageGet(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeLocalStorageSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		console.error(`Failed to set localStorage key: ${key}`);
	}
}

function safeLocalStorageRemove(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		// ignore
	}
}

/**
 * 清除所有认证信息并重定向到登录页
 */
export function clearAuthAndRedirect() {
  // 清除 localStorage
  safeLocalStorageRemove("token");
  safeLocalStorageRemove("refreshToken");
  safeLocalStorageRemove("user");

  // 清除 Pinia store 状态
  const userInfoStore = useUserInfo();
  const roomInfoStore = useRoomInfo();
  userInfoStore.$reset();
  roomInfoStore.$reset();

  // 销毁游戏客户端（如果存在）
  destoryMonopolyClient();

  // 跳转到登录页
  router.replace({ name: "login" });
}

export function setToken(token: string): void {
  safeLocalStorageSet("token", token);
}

export function setRefreshToken(token: string): void {
  safeLocalStorageSet("refreshToken", token);
}

export function getRefreshToken(): string | null {
  return safeLocalStorageGet("refreshToken");
}
