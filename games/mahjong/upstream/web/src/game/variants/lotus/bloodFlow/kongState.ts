import type { Meld, TileType } from '../../../core/contracts/types'

export type KongValueKind = 'discard-gang' | 'added-kong' | 'concealed-kong' | 'wind-kong'
export interface KongStateInput {
  kind: KongValueKind
  hand: readonly TileType[]
  melds: readonly Readonly<Meld>[]
  tile?: TileType
  meldIndex?: number
}

function removeCopies(tiles: readonly TileType[], tile: TileType, amount: number): TileType[] | null {
  const result = [...tiles]
  for (let index = 0; index < amount; index += 1) {
    const at = result.indexOf(tile)
    if (at < 0) return null
    result.splice(at, 1)
  }
  return result
}

const WINDS: readonly TileType[] = ['east', 'south', 'west', 'north']

/** 杠后的（手牌、副露）。精牌面按实体牌移除（与 engine.performKong 同口径）。 */
export function postKongState(input: KongStateInput): { hand: TileType[]; melds: Meld[] } | null {
  const melds = input.melds.map(meld => ({ ...meld }))
  if (input.kind === 'discard-gang') {
    if (!input.tile) return null
    const hand = removeCopies(input.hand, input.tile, 3)
    if (!hand) return null
    melds.push({ type: 'gang', tile: input.tile, tiles: Array(4).fill(input.tile) as TileType[] })
    return { hand, melds }
  }
  if (input.kind === 'concealed-kong') {
    if (!input.tile) return null
    const hand = removeCopies(input.hand, input.tile, 4)
    if (!hand) return null
    melds.push({ type: 'angang', tile: input.tile, tiles: Array(4).fill(input.tile) as TileType[] })
    return { hand, melds }
  }
  if (input.kind === 'wind-kong') {
    let hand: TileType[] | null = [...input.hand]
    for (const wind of WINDS) hand = hand ? removeCopies(hand, wind, 1) : null
    if (!hand) return null
    melds.push({ type: 'angang', tile: WINDS[0], tiles: [...WINDS], windKong: true })
    return { hand, melds }
  }
  const meldIndex = input.meldIndex ?? melds.findIndex(meld => meld.type === 'peng' && input.hand.includes(meld.tile))
  const meld = melds[meldIndex]
  if (!meld) return null
  const hand = removeCopies(input.hand, meld.tile, 1)
  if (!hand) return null
  melds[meldIndex] = { ...meld, type: 'gang', added: true, tiles: [...meld.tiles, meld.tile] }
  return { hand, melds }
}
