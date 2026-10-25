export const weatherLabels = {
  clear: '晴天',
  overcast: '阴天',
  light_rain: '小雨',
  rain: '中雨',
  heavy_rain: '大雨',
  thunderstorm: '雷暴',
  snow: '下雪',
} as const
export type WeatherKind = keyof typeof weatherLabels
/** 世界天气的七种类型之一 */
export function isWeatherKind(value: string | undefined): value is WeatherKind {
  return value !== undefined && Object.hasOwn(weatherLabels, value)
}
export type WeatherMode = 'natural' | 'fixed'
/** 天气控制失败的机器码（crates/protocol WeatherCode）；显示文案另给 */
export type WeatherCode =
  | 'invalid_weather'
  | 'revision_conflict'
  | 'weather_unavailable'
  | 'weather_unsafe'
  | 'save_failed'
  | 'world_mismatch'
  | 'world_not_ready'
export interface WeatherView {
  world_id: string
  revision: number
  kind: WeatherKind
  mode: WeatherMode
  changed_at: number
  last_transition: null | {
    id: number
    at: number
    from: WeatherKind
    to: WeatherKind
    source: 'natural' | 'manual'
  }
}
export interface WeatherPreferences {
  effects: boolean
  quality: 'low' | 'medium' | 'high'
  reduceMotion: boolean
  flash: boolean
}
export const weatherPreferencesEvent = 'town-weather-preferences'
const QUALITIES = ['low', 'medium', 'high'] as const
/** 粒子画质；其他取值（旧的或手改的本地存储）按中 */
export function weatherQuality(value: string | undefined): WeatherPreferences['quality'] {
  return QUALITIES.find((quality) => quality === value) ?? 'medium'
}
const key = 'town-weather-preferences-v1'
export function readWeatherPreferences(): WeatherPreferences {
  let data: Partial<WeatherPreferences> = {}
  try {
    data = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}
  } catch {
    /* 使用默认偏好 */
  }
  return {
    effects: data.effects !== false,
    quality: weatherQuality(data.quality),
    reduceMotion: data.reduceMotion === true,
    flash: data.flash === true,
  }
}
export function saveWeatherPreferences(value: WeatherPreferences) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 当前页面仍应用偏好 */
  }
  window.dispatchEvent(new CustomEvent(weatherPreferencesEvent, { detail: value }))
}
