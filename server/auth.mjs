/*
 * 账号：注册 / 登录 / 会话。
 *
 * 设计要点（为什么这么写，见 docs/DECISIONS.md D5）：
 *   · 玩家 ID 系统分配、全局唯一、**不可更改** —— 好友靠它添加，所以允许重名。
 *   · 密码用 scrypt 加盐哈希，**绝不存明文**。用异步版，避免登录时卡住所有人的对局。
 *   · 会话走 **HttpOnly cookie**：JS 拿不到，从源头免掉一类盗号方式。
 *   · **不做密码找回**（没有邮箱/手机号可验证）—— 注册成功后界面必须让用户把 ID 抄下来。
 */

import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import {
  ID_ALPHABET,
  ID_LENGTH,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  validateName,
  validatePassword,
} from '../shared/protocol.mjs';
import { publicUser } from './avatar.mjs';

const scryptAsync = promisify(scrypt);

const KEY_LEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/* ----------------------------- 密码 ----------------------------- */

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return { pwHash: key.toString('hex'), pwSalt: salt };
}

async function verifyPassword(password, pwHash, pwSalt) {
  const expected = Buffer.from(pwHash, 'hex');
  const actual = await scryptAsync(password, pwSalt, KEY_LEN, SCRYPT_PARAMS);
  // 长度不一致时 timingSafeEqual 会抛，先挡一下
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/* ----------------------------- 短码 ----------------------------- */

function randomCode(length, alphabet) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** 生成一个没被占用的玩家 ID。碰撞概率极低，但仍然老实重试。 */
function generateUserId(store) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = randomCode(ID_LENGTH, ID_ALPHABET);
    if (!store.userIdTaken(id)) return id;
  }
  throw new Error('无法分配玩家 ID（连续 20 次碰撞，这不正常）');
}

/* ----------------------------- 会话 ----------------------------- */

function newSessionId() {
  return randomBytes(32).toString('base64url');
}

/** 解析 Cookie 头。只做必要的事，不引入任何依赖。 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * 生成 Set-Cookie 的值。
 *
 * 关于 Secure：本项目服务端**永远只看到明文 HTTP**（TLS 由 Cloudflare 或 frpc 负责），
 * 所以不能无脑加 Secure —— 加了的话，走备用通道 http://<公网地址> 会登录不上。
 * 判据用 X-Forwarded-Proto：Cloudflare 会把它设成 https。
 */
export function sessionCookie(sid, { secure }) {
  const parts = [
    `${SESSION_COOKIE}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_S}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 请求是不是从 HTTPS 进来的（可能是 Cloudflare/frpc 终结的 TLS）。 */
export function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string') return proto.split(',')[0].trim() === 'https';
  return Boolean(req.socket && req.socket.encrypted);
}

/** 从请求里认出当前用户；没登录返回 null。 */
export function currentUser(store, req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  const session = store.findSession(sid);
  if (!session) return null;
  const user = store.findUser(session.user_id);
  if (!user) return null;
  return { ...publicUser(user), sid };
}

/* ----------------------------- 对外接口 ----------------------------- */

/**
 * 注册。返回 { ok, user, sid } 或 { ok:false, message }。
 * 注意：**允许重名**，所以只有密码强度与名字格式会被校验。
 */
export async function register(store, { name, password }) {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return nameCheck;
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return pwCheck;

  const { pwHash, pwSalt } = await hashPassword(pwCheck.password);
  const id = generateUserId(store);
  const user = store.createUser({ id, name: nameCheck.name, pwHash, pwSalt });

  const sid = newSessionId();
  store.createSession({ sid, userId: user.id });
  return { ok: true, user: publicUser(user), sid };
}

/**
 * 登录。**故意不区分"ID 不存在"和"密码错误"** —— 两者都回同一句话，
 * 免得成为枚举有效 ID 的工具（ID 空间虽然大，但没必要送这个方便）。
 */
export async function login(store, { id, password }) {
  const normalized = String(id ?? '').trim().toUpperCase();
  const generic = { ok: false, message: 'ID 或密码不对' };

  const user = normalized ? store.findUser(normalized) : null;
  if (!user) {
    // 仍然跑一次哈希，让"ID 不存在"和"密码错"耗时接近，不泄露 ID 是否存在
    await scryptAsync(String(password ?? ''), 'absent-user-placeholder', KEY_LEN, SCRYPT_PARAMS);
    return generic;
  }
  if (!(await verifyPassword(String(password ?? ''), user.pw_hash, user.pw_salt))) return generic;

  const sid = newSessionId();
  store.createSession({ sid, userId: user.id });
  return { ok: true, user: publicUser(user), sid };
}

export function logout(store, sid) {
  if (sid) store.deleteSession(sid);
}