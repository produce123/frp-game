import type { MapDocument } from 'town-shared/mapDocument'
import {
  defaultAppearance,
  savedAppearance,
  validateAppearance,
} from 'town-shared/props/appearances'
import { styleAppearance } from './map/styles/svgTown'
import { api } from './launcher/api'
import { themeOf } from './map/themes'
// 地图文档的加载与装饰：外观来自地图标记、浏览器保存值或风格默认值；地点归属沿用后端拓扑。

export type { Atlas, Topology, MapDocument } from 'town-shared/mapDocument'

const documentRequests = new Map<string, Promise<MapDocument>>()

function documentKey(townId: string, hash?: string) {
  return `ai-town:map-document:${townId}:${hash ?? 'latest'}`
}

function validDocument(doc: MapDocument, hash?: string) {
  return (
    [1, 2].includes(doc.schema_version) &&
    doc.style_id === 'svg-town-v1' &&
    doc.style_version === 1 &&
    (!hash || doc.content_hash === hash)
  )
}

function readCachedDocument(key: string, hash?: string) {
  try {
    const value = sessionStorage.getItem(key)
    if (!value) return null
    const doc = JSON.parse(value) as MapDocument
    if (validDocument(doc, hash)) return doc
    sessionStorage.removeItem(key)
  } catch {
    // Private browsing and storage limits must not block the game.
  }
  return null
}

function cacheDocument(key: string, doc: MapDocument) {
  try {
    sessionStorage.setItem(key, JSON.stringify(doc))
  } catch {
    // The HTTP cache remains available when session storage is full.
  }
}

export async function loadDocument(townId: string, hash?: string): Promise<MapDocument> {
  const key = documentKey(townId, hash)
  const cached = hash ? readCachedDocument(key, hash) : null
  if (cached) return cached
  const current = documentRequests.get(key)
  if (current) return current
  const request = api<MapDocument>(
    `/${encodeURIComponent(townId)}/map${hash ? '?hash=' + encodeURIComponent(hash) : ''}`
  ).then((doc) => {
    if (!validDocument(doc, hash)) throw new Error('地图版本不匹配')
    if (hash) cacheDocument(key, doc)
    return doc
  })
  documentRequests.set(key, request)
  request.finally(() => documentRequests.delete(key)).catch(() => {})
  return request
}
export function dataFromDocument(document: MapDocument) {
  const atlas = structuredClone(document.layout),
    topology = document.topology
  const marks = atlas.props.map((p) => ({ ...p }))
  const appearanceFor = (id: string, definition: string) => {
    const configured =
      marks.find((p) => p.id === id)?.appearance ??
      savedAppearance(definition) ??
      styleAppearance(definition)
    return configured ? validateAppearance(configured) : defaultAppearance
  }
  const decorate = () => {
    atlas.props = marks.map((mark) => {
      const prop = topology.props.find((p) => p.id === mark.id)
      if (!prop) throw new Error(`道具标记 ${mark.id} 没有对应世界实例`)
      const place = topology.locales.find((l) => l.id === prop.locale)
      return {
        ...mark,
        name: prop.name ?? mark.name ?? mark.id,
        place_name: place?.name ?? '',
        appearance: appearanceFor(mark.id, prop.definition ?? ''),
      }
    })
  }
  decorate()
  return { atlas, topology, decorate, appearanceFor, theme: themeOf(document) }
}
