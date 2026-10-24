/*
 * 头像：上传、存盘、默认头像生成。
 *
 * 【为什么不是第三方依赖】项目硬约束是零第三方运行时依赖（D6），
 * 图片只做"原样存盘 + 原样发回去"，缩放/裁剪交给浏览器 canvas。
 * 服务端只校验**魔术字节**，防止把任意文件伪装成图片塞进 data/。
 *
 * 【存储位置】跟着数据库走：`data/frp-game.db` → `data/avatars/<id>.<ext>`。
 * 测试用临时库时头像也落在临时目录里，跑完随临时目录一起删。
 *
 * 【默认头像】没上传过的人不返回 404，而是**现场生成一张 SVG**（ID 决定颜色、
 * 名字取前两个码点）。这样所有地方（平台、三个游戏、无名杀）都可以把头像
 * 当图片用，不必到处写"没有头像就画字"的兜底。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 上传上限。浏览器侧会先压到 256×256，正常只有几十 KB；2 MB 是防御值。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const EXT_BY_TYPE = {
  png: 'png',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
};

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** 头像地址。永远有值 —— 没上传过也是一个能取到默认图的地址。 */
export function avatarUrl(user) {
  const id = encodeURIComponent(String((user && user.id) || ''));
  const v = Number((user && user.avatar_at) || 0) || 0;
  return `/avatar/${id}?v=${v}`;
}

/** 对外的用户形状（**只含公开字段**，密码哈希永远不出这个函数）。 */
export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, avatar: avatarUrl(user) };
}

/**
 * 从文件头判断图片类型。返回 'png' / 'jpg' / 'gif' / 'webp'，不认识就 null。
 * 只信字节，不信客户端给的 content-type / 文件名。
 */
export function detectImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export function mimeForExt(ext) {
  return MIME_BY_EXT[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

/**
 * 头像仓库。`dir` 由调用方给（跟着数据库走）。
 */
export function createAvatarStore(dir) {
  mkdirSync(dir, { recursive: true });

  const pathFor = (id, ext) => join(dir, `${id}.${ext}`);

  return {
    dir,

    /**
     * 存一张新头像。成功返回 `{ ok:true, ext, bytes }`；不是合法图片返回错误。
     * 扩展名按**真实内容**定，不按上传时的文件名 —— 换格式后旧文件会被删掉。
     */
    save(id, buf) {
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return { ok: false, message: '没有收到图片' };
      }
      if (buf.length > AVATAR_MAX_BYTES) {
        return { ok: false, message: `图片太大了（最多 ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)} MB）` };
      }
      const type = detectImageType(buf);
      if (!type) {
        return { ok: false, message: '只支持 PNG / JPG / WebP / GIF 图片' };
      }
      const ext = EXT_BY_TYPE[type];
      // 换格式时把旧的删掉，别在盘上留一份永远没人读的文件
      for (const old of Object.values(EXT_BY_TYPE)) {
        if (old === ext) continue;
        rmSync(pathFor(id, old), { force: true });
      }
      writeFileSync(pathFor(id, ext), buf);
      return { ok: true, ext, bytes: buf.length };
    },

    /** 读上传过的头像；没上传过返回 null（调用方去生成默认图）。 */
    read(id, ext) {
      if (!ext) return null;
      const file = pathFor(id, String(ext).replace(/[^a-z0-9]/gi, ''));
      try {
        if (!existsSync(file)) return null;
        return readFileSync(file);
      } catch {
        return null;
      }
    },

    /** 恢复默认头像：把这个人所有格式的文件都删掉。 */
    clear(id) {
      for (const ext of Object.values(EXT_BY_TYPE)) {
        rmSync(pathFor(id, ext), { force: true });
      }
    },

    /** 仅供测试：某个人的头像文件在不在。 */
    has(id, ext) {
      try {
        return existsSync(pathFor(id, ext));
      } catch {
        return false;
      }
    },
  };
}

/** XML 文本转义（默认头像 SVG 里会放用户名字）。 */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 由 ID 稳定地取一个色相，保证每个人默认头像颜色不同且刷新不变。 */
function hueOf(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/**
 * 默认头像：一个带颜色的圆 + 名字前两个字符。
 * 128×128 足够所有界面用（平台圆 44px、无名杀头像也小）。
 */
export function defaultAvatarSvg(id, name) {
  const hue = hueOf(id);
  const bg = `hsl(${hue} 62% 42%)`;
  const bg2 = `hsl(${(hue + 28) % 360} 62% 32%)`;
  const chars = [...String(name || '?')].slice(0, 2).join('') || '?';
  const fontSize = [...chars].length > 1 ? 44 : 58;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${bg2}"/>` +
      `</linearGradient></defs>` +
      `<circle cx="64" cy="64" r="64" fill="url(#g)"/>` +
      `<text x="64" y="64" fill="#fff" font-family="system-ui,'Segoe UI',sans-serif" ` +
      `font-size="${fontSize}" font-weight="600" text-anchor="middle" dominant-baseline="central">` +
      `${escapeXml(chars)}</text>` +
      `</svg>`,
    'utf8'
  );
}