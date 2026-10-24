/*
 * 游戏注册表（服务端）。
 *
 * 加一个游戏 = 写一个 `server/games/<slug>.mjs`（导出 meta / createMatch），
 * **不需要改这个文件** —— 它按文件名自动发现同目录下的 `*.mjs`。
 *
 * 为什么改成自动发现：三个游戏是并行搬进来的，如果还要手写一份清单，
 * 每搬一个都得改同一个文件。自动发现把"改动点"限制在各自的目录里，
 * 减少互相踩。代价是"服务器上接了哪几个游戏"要看目录列表而不是看这个文件 ——
 * 所以启动日志里会把已接游戏打出来（见 server/server.mjs）。
 *
 * 顺序按文件名排序，保证每次启动一致（不是什么要紧事，但可复现好排查）。
 *
 * 游戏接口与搬迁状态见 docs/ARCHITECTURE.md 与 docs/GAMES.md。
 */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 这个文件自己不是游戏模块。 */
const NOT_A_GAME = new Set(['index.mjs']);

/** @returns {Promise<{games: Map<string, object>, failures: {file: string, message: string}[]}>} */
export async function loadGames() {
  const files = (await readdir(HERE))
    .filter((name) => name.endsWith('.mjs') && !NOT_A_GAME.has(name))
    .sort();

  const games = new Map();
  /** 加载失败的游戏模块。**不静默** —— 由调用方打出来，启动日志必须打出来（不许静默）。 */
  const failures = [];

  for (const file of files) {
    const path = join(HERE, file);
    let mod;
    try {
      mod = await import(pathToFileURL(path).href);
    } catch (err) {
      // 一个游戏模块坏掉，只让**这个游戏**下线，不要连累整个平台。
      // 三个游戏是并行开发的，一个写了一半不该把别人的验证卡死。
      failures.push({ file, message: String(err && err.message || err) });
      continue;
    }

    try {
      const slug = mod.meta && mod.meta.slug;
      if (!slug) throw new Error('缺少 meta.slug');
      if (typeof mod.createMatch !== 'function') throw new Error('没有导出 createMatch');

      const expected = file.replace(/\.mjs$/, '');
      if (slug !== expected) {
        throw new Error(`meta.slug 是「${slug}」，必须和文件名「${expected}」一致`);
      }
      if (games.has(slug)) throw new Error(`游戏 slug 重复：${slug}`);

      games.set(slug, mod);
    } catch (err) {
      failures.push({ file, message: String(err && err.message || err) });
    }
  }

  return { games, failures };
}