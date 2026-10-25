import type { MapEntry } from 'town-shared/mapDocument'
import { loadDocument } from './assets'

const warmed = new Set<string>()

/** Warm the selected game's immutable files while the player is still reading its preview. */
export function warmSelectedGame(map: MapEntry) {
  const version = map.mapHash
  if (!version || warmed.has(`${map.id}:${version}`)) return
  warmed.add(`${map.id}:${version}`)
  void import('./main').catch(() => {})
  void loadDocument(map.id, version).catch(() => {})
}
