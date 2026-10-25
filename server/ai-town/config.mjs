/*
 * AI 小镇（my_ai_town）的接入常量。
 *
 * 上游是 **Rust 世界 host + Rust town-manager + 静态前端**：
 *   · town-manager 只监听 127.0.0.1，管 /api/towns（建镇/开镇/关镇/模型下载）；
 *   · 每次开镇它会拉起一个 host 子进程，host 的 WS 端口是**随机**的；
 *   · host 自己再拉起 llama-server（内置小模型）。
 *
 * 平台这一层只做三件事：静态托管 / 账号注入 / 把 HTTP 与 WS 反代到本机。
 * 所有路径、上限、超时都收在这个文件里，别的模块不许自己读 process.env。
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 上游源码 / 构建产物 / 二进制。 */
export const AI_TOWN_DIR = join(ROOT, 'games', 'ai-town');
export const UPSTREAM_DIR = join(AI_TOWN_DIR, 'upstream');
export const WEB_DIR = join(AI_TOWN_DIR, 'web');
export const BIN_DIR = join(AI_TOWN_DIR, 'bin');

/** 每个平台用户一个数据根（--root），里面是存档、内置模型、日志。 */
export const DATA_DIR = process.env.AI_TOWN_DATA_DIR
  ? resolve(process.env.AI_TOWN_DATA_DIR)
  : join(ROOT, 'data', 'ai-town');
export const USERS_DIR = join(DATA_DIR, 'users');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const PROCESS_FILE = join(DATA_DIR, 'processes.json');
/** 内置模型只存一份；每个用户根里用硬链接指过来（同盘不占额外空间）。 */
export const SHARED_MODEL = join(DATA_DIR, 'models', 'model.gguf');

const env = process.env;

/** 可执行文件。优先环境变量，其次 games/ai-town/bin（部署时放这里）。 */
export const MANAGER_BIN = env.AI_TOWN_MANAGER_BIN || join(BIN_DIR, 'town-manager.exe');
export const HOST_BIN = env.AI_TOWN_HOST_BIN || join(BIN_DIR, 'town-host.exe');
/** 没有构建产物时，允许直接指到 cargo 的 target/debug。 */
export const FALLBACK_MANAGER_BIN = join(UPSTREAM_DIR, 'target', 'debug', 'town-manager.exe');
export const FALLBACK_HOST_BIN = join(UPSTREAM_DIR, 'target', 'debug', 'host.exe');

/** 同时开着的世界数（用户明确要 2 个）。 */
export const MAX_ROOMS = Number(env.AI_TOWN_MAX_ROOMS || 2) || 2;
/** 一个房间最多几个人：房主 + 3 位客人（游戏卡上也写 4）。 */
export const MAX_ROOM_MEMBERS = Number(env.AI_TOWN_MAX_MEMBERS || 4) || 4;
/** 同时活着的 manager 进程数；2 个用户同时开镇就是 2 个。 */
export const MAX_MANAGERS = Number(env.AI_TOWN_MAX_MANAGERS || 2) || 2;

/** 一个房间最多几条 WS 管道（房主 + 客人 + 重连余量）。 */
export const MAX_PIPES_PER_ROOM = Number(env.AI_TOWN_MAX_PIPES || 8) || 8;
/** 邀请/深链换来的进镇票据有效期。 */
export const TICKET_TTL_MS = 10 * 60 * 1000;
/** 没有任何 WS 管道后，房间还能活多久（给刷新/重连留时间）。 */
export const IDLE_ROOM_MS = Number(env.AI_TOWN_IDLE_ROOM_MS || 5 * 60 * 1000);
/** manager 空闲多久回收。 */
export const IDLE_MANAGER_MS = Number(env.AI_TOWN_IDLE_MANAGER_MS || 10 * 60 * 1000);
/** 等 manager 就绪 / 退出的上限。 */
export const START_TIMEOUT_MS = Number(env.AI_TOWN_START_TIMEOUT_MS || 30_000);
export const STOP_TIMEOUT_MS = Number(env.AI_TOWN_STOP_TIMEOUT_MS || 10_000);
/** 反代单个 HTTP 请求的超时。 */
export const PROXY_TIMEOUT_MS = Number(env.AI_TOWN_PROXY_TIMEOUT_MS || 120_000);

/** 平台自己的公开前缀（与 /api/towns 分开，排障时一眼能分清是谁的 404）。 */
export const API_PREFIX = '/ai-town/api/platform';
export const TOWN_API_PREFIX = '/ai-town/api/towns';
export const PROPS_PREFIX = '/ai-town/data/props';
export const WS_PATH = '/ai-town/ws';

/** 前端桥脚本：放在 web/，不放进 games/ai-town/web（重新构建会被覆盖）。 */
export const BRIDGE_FILE = join(ROOT, 'web', 'ai-town-bridge.js');
export const BRIDGE_URL = '/ai-town/frp-bridge.js';
/** 改了桥脚本就 +1，浏览器不会拿旧缓存。 */
export const BRIDGE_VERSION = '10';

export function managerBin() {
  return MANAGER_BIN;
}

export function hostBin() {
  return HOST_BIN;
}

export function userRoot(userId) {
  return join(USERS_DIR, String(userId));
}

export function managerLog(userId) {
  return join(LOG_DIR, `manager-${String(userId)}.log`);
}