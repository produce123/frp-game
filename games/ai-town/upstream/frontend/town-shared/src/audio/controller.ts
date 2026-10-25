import type { WeatherKind } from '../weather/types'
import { createEffectsController, type MovementSoundState } from './effects'
import { createMusicController } from './music'

export type GameAudio = ReturnType<typeof createGameAudio>

export function createGameAudio(musicButton: HTMLButtonElement, effectsButton: HTMLButtonElement) {
  const music = createMusicController(musicButton)
  const effects = createEffectsController(effectsButton)
  let clock = '12:00'
  let weather: WeatherKind | undefined
  const applyEnvironment = () => {
    music.update(clock, weather)
    effects.updateEnvironment(clock, weather)
  }
  return {
    /** 顶栏与设定中心「声音与按键」页共用的两个开关 */
    music: { enabled: music.enabled, toggle: music.toggle },
    effects: { enabled: effects.enabled, toggle: effects.toggle },
    /** 名册可以只带时钟；没有新的天气字段时保留上次的天气。 */
    update(nextClock: string, nextAuthoritativeWeather?: WeatherKind) {
      clock = nextClock
      if (nextAuthoritativeWeather !== undefined) weather = nextAuthoritativeWeather
      applyEnvironment()
    },
    updateMovement(state: MovementSoundState) {
      effects.updateMovement(state)
    },
    playDescend() {
      effects.playDescend()
    },
    dispose() {
      music.dispose()
      effects.dispose()
    },
  }
}
