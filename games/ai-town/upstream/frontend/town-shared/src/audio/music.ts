import { MUSIC_TRACKS, tracksForScene, type MusicTrack } from './catalog'
import { resolveAudioScene, type AudioScene } from './scene'
import type { WeatherKind } from '../weather/types'
import { createAudioFader } from './fade'
import { readSwitch, saveSwitch } from './preference'

// 音乐默认开：换过键名，旧版存下的「关」不再沿用，之后的选择照常记住
const ENABLED_KEY = 'ai-town:music-on'
const DEFAULT_VOLUME = 0.32

export function createMusicController(
  button: HTMLButtonElement,
  options: { fixedTrackId?: string } = {}
) {
  let enabled = readSwitch(ENABLED_KEY)
  // 浏览器在页面上有过点击或按键之前不许出声：开着却被拦下时记着，下一次操作再放
  let blocked = false
  let scene: AudioScene = 'day'
  let current: HTMLAudioElement | null = null
  let lastTrackId = ''
  let playRequest = 0

  const updateButton = (track?: MusicTrack) => {
    // 写明是音乐、开着还是关着：只有符号时分不清音乐和音效，也看不出是状态还是按钮
    button.textContent = enabled ? '♫ 音乐：开' : '♫ 音乐：关'
    button.setAttribute('aria-label', enabled ? '音乐：开' : '音乐：关')
    button.setAttribute('aria-pressed', String(enabled))
    button.title = enabled
      ? track
        ? `背景音乐正在播放：${track.title}（点击关闭）`
        : '背景音乐已开启（下次操作后播放）'
      : '背景音乐已关闭（点击开启）'
  }
  const clearAudio = (audio: HTMLAudioElement) => {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
  const fader = createAudioFader(clearAudio)
  const chooseTrack = () => {
    if (options.fixedTrackId) return MUSIC_TRACKS.find((track) => track.id === options.fixedTrackId)
    const tracks = tracksForScene(scene)
    const alternatives = tracks.filter((track) => track.id !== lastTrackId)
    const pool = alternatives.length ? alternatives : tracks
    return pool[Math.floor(Math.random() * pool.length)]
  }
  const playNext = async () => {
    if (!enabled || document.hidden) return
    const request = ++playRequest
    const track = chooseTrack()
    if (!track) return
    blocked = false
    const next = new Audio(track.url)
    next.preload = 'auto'
    next.volume = DEFAULT_VOLUME
    next.addEventListener(
      'ended',
      () => {
        if (current === next) void playNext()
      },
      { once: true }
    )
    next.addEventListener(
      'error',
      () => {
        if (current === next) {
          current = null
          updateButton()
        }
      },
      { once: true }
    )
    try {
      await next.play()
      if (request !== playRequest || !enabled || document.hidden) {
        clearAudio(next)
        return
      }
      const previous = current
      current = next
      lastTrackId = track.id
      updateButton(track)
      if (previous && previous !== next) {
        fader.stop()
        fader.fadeOut(previous)
      }
    } catch (error) {
      clearAudio(next)
      if (request === playRequest)
        blocked = error instanceof DOMException && error.name === 'NotAllowedError'
      updateButton()
    }
  }
  const stop = () => {
    playRequest += 1
    fader.stop()
    if (current) clearAudio(current)
    current = null
    updateButton()
  }
  const onVisibility = () => {
    if (document.hidden) {
      fader.stop()
      current?.pause()
    } else if (enabled) {
      if (current) void current.play().catch(() => updateButton())
      else void playNext()
    }
  }
  // 点音乐开关本身交给开关处理：不然按下时先放出来，松开时又被开关关掉
  const onGesture = (event: Event) => {
    if (blocked && !button.contains(event.target as Node)) void playNext()
  }
  document.addEventListener('pointerdown', onGesture, true)
  document.addEventListener('keydown', onGesture, true)
  document.addEventListener('visibilitychange', onVisibility)
  const toggle = () => {
    // 显示开着、却被浏览器拦着没响：这一下是要听，放出来而不是关掉
    if (enabled && blocked) {
      void playNext()
      return
    }
    enabled = !enabled
    saveSwitch(ENABLED_KEY, enabled)
    if (enabled) void playNext()
    else stop()
    updateButton(current ? MUSIC_TRACKS.find((track) => track.id === lastTrackId) : undefined)
  }
  button.onclick = (event) => {
    event.stopPropagation()
    toggle()
  }
  updateButton()
  // 打开页面就试着放；被浏览器拦下时，页面上第一次点击或按键再放
  if (enabled) void playNext()

  return {
    enabled: () => enabled,
    toggle,
    update(clock: string, weather?: WeatherKind) {
      const nextScene = resolveAudioScene(clock, weather)
      if (scene === nextScene) return
      scene = nextScene
      if (current && enabled) void playNext()
    },
    dispose() {
      document.removeEventListener('pointerdown', onGesture, true)
      document.removeEventListener('keydown', onGesture, true)
      document.removeEventListener('visibilitychange', onVisibility)
      button.onclick = null
      stop()
    },
  }
}
