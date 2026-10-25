import fs from 'node:fs/promises'
import path from 'node:path'
import { preferredEncoding } from '../performance/http-compression.mjs'
import { Raw, HttpError } from './http.mjs'
// HD-2D 页面、构建脚本和共享道具定义。
export function createAssetRoutes({ source, storage }) {
  const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
  }
  const IMMUTABLE = 'public, max-age=31536000, immutable'
  async function staticFile({ params: [file = 'index.html'], headers }) {
    return builtFile('frontend/town-2d/dist', file, headers, '页面不存在，请先构建前端')
  }
  async function builtFile(directory, file, headers, missing) {
    const full = path.join(source, directory, file)
    let content,
      encoding = null
    const preferred = preferredEncoding(headers?.['accept-encoding'])
    if (preferred && /\.(js|css|json)$/.test(file)) {
      try {
        content = await fs.readFile(full + (preferred === 'br' ? '.br' : '.gz'))
        encoding = preferred
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
    }
    try {
      content ??= await fs.readFile(full)
    } catch (e) {
      if (e.code === 'ENOENT') throw new HttpError(404, missing)
      throw e
    }
    const ext = path.extname(full)
    return new Raw(content, {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      Vary: 'Accept-Encoding',
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
      'Cache-Control': ext === '.html' ? 'no-store' : IMMUTABLE,
    })
  }
  async function propDefinitions() {
    return new Raw(await fs.readFile(path.join(source, 'data/props/core/definitions.json')), {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    })
  }
  const routes = [
    ['GET', /^\/data\/props\/core\/definitions\.json$/, propDefinitions],
    ['GET', /^(?:\/((?:index\.html|game\.html|assets\/[a-zA-Z0-9._-]+)))?$/, staticFile],
  ]
  return { routes }
}
