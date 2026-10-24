/*
 * 把官方公开地图拉一份到本机（`games/monopoly/maps/`）。
 *
 * ⚠️ 版权：地图不是 GPL 代码，作者 FatPaper 在爱发电卖地图源文件。
 * 官方站的 `/game-map/list` 与 COS 地址是公开的，本脚本只是把「官方客户端本来就会下载的
 * 可玩地图（.mmmap）」缓存到自建服务器，**不包含付费的 .fpmap 源文件**。
 * 只在自己和朋友的小范围使用；要公开分发/商用请先取得作者授权。
 *
 * 用法：
 *   node games/monopoly/tools/fetch-official-maps.mjs
 *
 * 地图清单接口来自上游 `apps/server`（`/game-map/list`），字段解释见
 * `apps/client/src/utils/api/map.ts`。
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAPS_DIR = join(ROOT, 'maps');
const COVERS_DIR = join(MAPS_DIR, 'covers');

const API = 'https://fatpaper.site/monopoly-server/game-map/list?page=1&size=50&inuse=true';

function extFromUrl(url, fallback = '.png') {
  const clean = String(url || '').split('?')[0];
  const dot = clean.lastIndexOf('.');
  const slash = clean.lastIndexOf('/');
  return dot > slash ? clean.slice(dot) : fallback;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  await mkdir(COVERS_DIR, { recursive: true });

  const res = await fetch(API);
  if (!res.ok) throw new Error(`地图列表失败 ${res.status}`);
  const body = await res.json();
  const list = body?.data?.gameMapList;
  if (!Array.isArray(list) || list.length === 0) throw new Error('地图列表是空的');

  const maps = [];
  for (const item of list) {
    if (!item.id || !item.mapUrl) continue;
    const id = String(item.id);
    const mapExt = extFromUrl(item.mapUrl, '.mmmap');
    const coverExt = extFromUrl(item.coverUrl, '.png');
    const mapFile = `${id}${mapExt}`;
    const coverFile = `${id}${coverExt}`;

    process.stdout.write(`下载 ${item.name || id} ... `);
    const mapBytes = await download(item.mapUrl);
    await writeFile(join(MAPS_DIR, mapFile), mapBytes);

    let coverPath = '';
    if (item.coverUrl) {
      const coverBytes = await download(item.coverUrl);
      await writeFile(join(COVERS_DIR, coverFile), coverBytes);
      coverPath = `covers/${coverFile}`;
    }

    const hash = createHash('sha256').update(mapBytes).digest('hex');
    maps.push({
      id,
      name: String(item.name || '大富翁地图'),
      author: String(item.author || ''),
      version: Number(item.version) || 1,
      description: String(item.description || ''),
      hash,
      file: mapFile,
      cover: coverPath,
      inuse: true,
    });
    console.log(`OK ${(mapBytes.length / 1024 / 1024).toFixed(1)} MB`);
  }

  const manifest = {
    source: API,
    fetchedAt: new Date().toISOString(),
    note: '官方公开可玩地图（.mmmap），不含付费 .fpmap 源文件；仅供自用。',
    maps,
  };
  await writeFile(join(MAPS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n写入 ${maps.length} 张地图 -> ${MAPS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});