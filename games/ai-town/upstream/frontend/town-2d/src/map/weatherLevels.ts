import type { WeatherKind } from 'town-shared/weather/types'

// 每种天气的强度（0～1）。立体场景的天气（hd2d/weather.ts）和立体场景起不来时平面图上的
// 天气层（src/weather.ts）都按这张表画。

export interface WeatherLevels {
  /** 云量：压低日照和饱和度 */
  cloud: number
  /** 天空被云盖满：影子变淡变软，画面偏冷 */
  overcast: number
  rain: number
  snow: number
  wind: number
  /** 晴天飘过的云影 */
  shadows: number
  /** 晴天偶尔飘过的落叶花瓣 */
  leaves: number
  storm: number
}

export const WEATHER_LEVELS: Record<WeatherKind, WeatherLevels> = {
  clear: { cloud: 0, overcast: 0, rain: 0, snow: 0, wind: 0.3, shadows: 1, leaves: 1, storm: 0 },
  overcast: {
    cloud: 0.5,
    overcast: 1,
    rain: 0,
    snow: 0,
    wind: 0.5,
    shadows: 0,
    leaves: 0.5,
    storm: 0,
  },
  light_rain: {
    cloud: 0.6,
    overcast: 1,
    rain: 0.3,
    snow: 0,
    wind: 0.5,
    shadows: 0,
    leaves: 0,
    storm: 0,
  },
  rain: {
    cloud: 0.75,
    overcast: 1,
    rain: 0.6,
    snow: 0,
    wind: 0.7,
    shadows: 0,
    leaves: 0,
    storm: 0,
  },
  heavy_rain: {
    cloud: 0.85,
    overcast: 1,
    rain: 1,
    snow: 0,
    wind: 0.9,
    shadows: 0,
    leaves: 0,
    storm: 0,
  },
  thunderstorm: {
    cloud: 0.9,
    overcast: 1,
    rain: 1,
    snow: 0,
    wind: 1,
    shadows: 0,
    leaves: 0,
    storm: 1,
  },
  snow: { cloud: 0.6, overcast: 1, rain: 0, snow: 1, wind: 0.35, shadows: 0, leaves: 0, storm: 0 },
}
