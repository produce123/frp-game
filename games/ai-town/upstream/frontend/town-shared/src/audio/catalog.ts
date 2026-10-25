import type { WeatherKind } from '../weather/types'
import type { AudioScene } from './scene'

export interface MusicTrack {
  id: string
  title: string
  scene: AudioScene
  url: string
}

export const MUSIC_TRACKS: readonly MusicTrack[] = [
  {
    id: 'daylife-gathering',
    title: '晨集小镇',
    scene: 'day',
    url: new URL('../../assets/music/music_town_daylife_gathering.m4a', import.meta.url).href,
  },
  {
    id: 'daylife-market',
    title: '晨市像素日',
    scene: 'day',
    url: new URL('../../assets/music/music_town_daylife_market.m4a', import.meta.url).href,
  },
  {
    id: 'daylife-corner-opening',
    title: '街角开门时',
    scene: 'day',
    url: new URL('../../assets/music/music_town_daylife_corner_opening.m4a', import.meta.url).href,
  },
  {
    id: 'daylife-window-afternoon',
    title: '窗边午后小镇',
    scene: 'day',
    url: new URL('../../assets/music/music_town_daylife_window_afternoon.m4a', import.meta.url)
      .href,
  },
  {
    id: 'evening-workshop-lights',
    title: '夜工坊灯火',
    scene: 'evening',
    url: new URL('../../assets/music/music_town_evening_workshop_lights.m4a', import.meta.url).href,
  },
  {
    id: 'evening-lane-breeze',
    title: '巷口晚风',
    scene: 'evening',
    url: new URL('../../assets/music/music_town_evening_lane_breeze.m4a', import.meta.url).href,
  },
  {
    id: 'evening-dusk-town',
    title: '暮色小镇',
    scene: 'evening',
    url: new URL('../../assets/music/music_town_evening_dusk_town.m4a', import.meta.url).href,
  },
  {
    id: 'rain-window-town-01',
    title: '窗边小镇',
    scene: 'rain',
    url: new URL('../../assets/music/music_town_rain_window_town_01.m4a', import.meta.url).href,
  },
  {
    id: 'rain-window-town-02',
    title: '窗边小镇（变体）',
    scene: 'rain',
    url: new URL('../../assets/music/music_town_rain_window_town_02.m4a', import.meta.url).href,
  },
  {
    id: 'thunderstorm-after-rain-01',
    title: '雨后小镇',
    scene: 'thunderstorm',
    url: new URL('../../assets/music/music_town_thunderstorm_after_rain_01.m4a', import.meta.url)
      .href,
  },
  {
    id: 'thunderstorm-after-rain-02',
    title: '雨后小镇（变体）',
    scene: 'thunderstorm',
    url: new URL('../../assets/music/music_town_thunderstorm_after_rain_02.m4a', import.meta.url)
      .href,
  },
  {
    id: 'sleep-belltower-01',
    title: '沉睡钟楼',
    scene: 'sleep',
    url: new URL('../../assets/music/music_town_sleep_belltower_01.m4a', import.meta.url).href,
  },
  {
    id: 'sleep-belltower-02',
    title: '沉睡钟楼（变体）',
    scene: 'sleep',
    url: new URL('../../assets/music/music_town_sleep_belltower_02.m4a', import.meta.url).href,
  },
]

export const EFFECT_ASSETS = {
  ambience: {
    rain: new URL('../../assets/effects/ambience/amb_town_rain_loop.ogg', import.meta.url).href,
    sleep: new URL(
      '../../assets/effects/ambience/amb_sleep_soft_white_noise_loop.m4a',
      import.meta.url
    ).href,
  },
  thunder: new URL('../../assets/effects/sfx/weather/sfx_thunder_generated.ogg', import.meta.url)
    .href,
  descend: new URL('../../assets/effects/sfx/avatar/sfx_avatar_descend.ogg', import.meta.url).href,
  footsteps: {
    outdoor: [
      new URL('../../assets/effects/sfx/footsteps/sfx_footstep_outdoor_01.ogg', import.meta.url)
        .href,
      new URL('../../assets/effects/sfx/footsteps/sfx_footstep_outdoor_02.ogg', import.meta.url)
        .href,
      new URL('../../assets/effects/sfx/footsteps/sfx_footstep_outdoor_03.ogg', import.meta.url)
        .href,
    ],
    indoor: [
      new URL('../../assets/effects/sfx/footsteps/sfx_footstep_indoor_01.ogg', import.meta.url)
        .href,
      new URL('../../assets/effects/sfx/footsteps/sfx_footstep_indoor_02.ogg', import.meta.url)
        .href,
      new URL('../../assets/effects/sfx/footsteps/sfx_footstep_indoor_03.ogg', import.meta.url)
        .href,
    ],
    wet: [
      new URL('../../assets/effects/sfx/footsteps/sfx_footstep_wet_01.ogg', import.meta.url).href,
      new URL('../../assets/effects/sfx/footsteps/sfx_footstep_wet_02.ogg', import.meta.url).href,
      new URL('../../assets/effects/sfx/footsteps/sfx_footstep_wet_03.ogg', import.meta.url).href,
    ],
  },
} as const

type FootstepSurface = keyof typeof EFFECT_ASSETS.footsteps

export function tracksForScene(scene: AudioScene): readonly MusicTrack[] {
  return MUSIC_TRACKS.filter((track) => track.scene === scene)
}

export function rainAmbienceVolume(weather?: WeatherKind): number {
  if (weather === 'thunderstorm') return 0.3
  if (weather === 'heavy_rain') return 0.25
  if (weather === 'rain') return 0.2
  return 0.14
}

export function resolveFootstepSurface(
  locale: string,
  space: string | undefined,
  atKind: string | undefined,
  weather?: WeatherKind
): FootstepSurface {
  const indoors =
    (!!space && space !== 'town_outdoor') ||
    atKind === 'station' ||
    /(?:^|_)(?:indoor|interior|home|house)(?:_|$)/i.test(locale)
  if (indoors) return 'indoor'
  return weather === 'light_rain' ||
    weather === 'rain' ||
    weather === 'heavy_rain' ||
    weather === 'thunderstorm'
    ? 'wet'
    : 'outdoor'
}
