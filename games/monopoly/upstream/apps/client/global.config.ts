import { env } from "@mine-monopoly/env";

// 基础环境变量
export const __USERSERVERHOST__ = `http://localhost:${env<number>("SERVER_PORT", 81)}`;

const prefix = env("API_BASE_PREFIX", "");
const domain = env("MONOPOLY_DOMAIN");
const protocol = env("PROTOCOL");
const port = env<number>("SERVER_PORT", 81);
const adminPort = env<number>("MONOPOLY_ADMIN_PORT", 83);
const icePrefix = env("ICE_BASE_PREFIX", "") || prefix;
const adminPrefix = env("ADMIN_BASE_PREFIX", "") || prefix;

// 根据前缀配置生成服务器地址（frp-game：同源相对路径，见 utils/api/index.ts）
export const __MONOPOLYSERVERHOST__ = prefix
	? prefix.slice(1)
	: `${domain}:${port}`;
export const __APIPORT__ = env<number>("SERVER_PORT", 81);
export const __ICE_SERVER_PORT__ = env<number>("ICE_SERVER_PORT", 3478);
export const __MONOPOLYSERVER__ = prefix
	? prefix
	: `${protocol}://${domain}:${port}`;

// ICE 服务配置
// 有前缀时：使用域名 + 前缀作为 PeerJS path（配合 nginx 反代）
// 无前缀时：使用端口模式，path 为默认的 /peerjs
export const __ICE_SERVER_PATH__ = icePrefix || "/peerjs";
export const __ICE_SERVER_HOST__ = icePrefix
	? `${protocol}://${domain}`
	: `${protocol}://${domain}`;
export const __ICE_USE_PREFIX__ = !!icePrefix;

// Admin 服务地址
export const __MONOPOLY_ADMIN__ = adminPrefix
	? `${protocol}://${domain}${adminPrefix}`
	: `${protocol}://${domain}:${adminPort}`;

export const __FATPAPER_HOST__ = env("MONOPOLY_DOMAIN");
export const __PROTOCOL__ = env("PROTOCOL");

// 腾讯云配置（可选）
export const __TC_ID__ = env("TC_ID", "");
export const __TC_KEY__ = env("TC_KEY", "");
export const __TC_BUCKET_NAME__ = env("TC_BUCKET_NAME", "");
export const __TC_REGION__ = env("TC_REGION", "");
