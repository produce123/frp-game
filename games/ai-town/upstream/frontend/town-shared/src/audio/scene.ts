import type { WeatherKind } from '../weather/types'

export type AudioScene = 'day' | 'evening' | 'rain' | 'thunderstorm' | 'sleep'

export function resolveAudioScene(clock: string, weather?: WeatherKind): AudioScene {
  if (weather === 'thunderstorm') return 'thunderstorm'
  if (weather === 'light_rain' || weather === 'rain' || weather === 'heavy_rain') return 'rain'
  const match = clock.match(/(?:^|\D)([01]?\d|2[0-3]):[0-5]\d(?:\D|$)/)
  const hour = match ? Number(match[1]) : 12
  if (hour >= 23 || hour < 7) return 'sleep'
  if (hour >= 18) return 'evening'
  return 'day'
}
