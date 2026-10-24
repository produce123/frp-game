import { describe, expect, it } from 'vitest'
import type { Meld, TileType } from '../../../core/contracts/types'
import { evaluateWin } from '../patterns/evaluate'
import { decideBloodFlowAction, decideBloodFlowActionEv } from './ai'
import { preferredAnyWaitKong } from './anyWaitKong'
import type { BloodFlowSeatView } from './seatView'
import type { BloodFlowAction } from './state'

function turn(hand: TileType[], kong: BloodFlowAction, wallCount = 40, locked = false, melds: Meld[] = []) {
  const jokers: TileType[] = ['red','green']
  const score = evaluateWin({ concealed: hand.slice(0, -1), winningTile: hand.at(-1)!, melds, jokers, source: 'self-draw', opening: null })?.score
  return {
    seat: 0, wallCount, jokers, flipTile: 'red',
    players: [0,1,2,3].map(seat => ({ seat, score: 2000, hand: seat ? [] : hand, melds: seat ? [] : melds,
      discards: [], drawnTileIndex: seat ? -1 : hand.length - 1 })),
    public: { seats: [0,1,2,3].map(seat => ({ locked: seat === 0 && locked, winCount: seat === 0 && locked ? 1 : 0 })), batches: [] },
    window: { kind: 'turn', source: { kind: 'draw', tile: hand.at(-1), seat: 0 } },
    ownActions: [...(score ? [{ kind: 'win' }] : []), kong, { kind: 'discard', index: hand.length - 1 }], ownScore: score ?? null,
  } as unknown as BloodFlowSeatView
}

describe('任意听开杠的真实计分比较', () => {
  const concealed: TileType[] = ['m1','m1','m1','m2','m3','m4','p1','p2','p3','east','east','east','red','m1']
  const winds: TileType[] = ['east','south','west','m2','m3','m4','p4','p5','p6','s6','s7','s8','red','north']
  const smaller: TileType[] = ['m1','m1','m1','m2','m2','m3','m3','m4','m4','p5','p5','red','green','m1']
  const kong: BloodFlowAction = { kind: 'concealed-kong', tile: 'm1' }
  it.each([false, true])('锁手=%s 时，暗杠和风杠保留任意听且不降倍就杠开', locked => {
    for (const [hand, action] of [[concealed, kong], [winds, { kind: 'wind-kong' }]] as [TileType[], BloodFlowAction][]) {
      const view = turn(hand, action, 40, locked)
      expect(preferredAnyWaitKong(view, view.ownActions)).toEqual(action)
      expect(decideBloodFlowActionEv(view)).toEqual(action)
      expect(decideBloodFlowAction(view)).toEqual(action)
    }
  })
  it('还有后续摸牌时，不用一次杠开换取续胡降倍', () => {
    const view = turn(smaller, kong)
    expect(preferredAnyWaitKong(view, view.ownActions)).toBeNull()
  })
  it('墙余一张时允许降低常规倍数，补牌仍保证杠开且期望收益不低于立即胡', () => {
    const view = turn(smaller, kong, 1, true)
    expect(preferredAnyWaitKong(view, view.ownActions)).toEqual(kong)
    expect(decideBloodFlowActionEv(view)).toEqual(kong)
  })
  it('牌墙已空时直接胡；不能开杠，也不能用第五张计算补牌收益', () => {
    const view = turn(concealed, kong, 0, true)
    view.ownActions = view.ownActions.filter(a => a.kind !== 'concealed-kong')
    expect(preferredAnyWaitKong(view, view.ownActions)).toBeNull()
    expect(decideBloodFlowActionEv(view)).toEqual({ kind: 'win' })
  })
  it('拆散豪华七对的暗杠即使末张也不保证杠开', () => {
    const view = turn(['m1','m1','m1','m1','p2','p2','p5','p5','s3','s3','s8','s8','red','m7'], kong, 1, true)
    expect(preferredAnyWaitKong(view, view.ownActions)).toBeNull()
    expect(decideBloodFlowActionEv(view)).toEqual({ kind: 'win' })
  })
})
