export function createAudioFader(clearAudio: (audio: HTMLAudioElement) => void, duration = 700) {
  let frame = 0
  let fading: HTMLAudioElement | null = null

  function stop() {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    if (fading) clearAudio(fading)
    fading = null
  }

  function fadeOut(audio: HTMLAudioElement) {
    fading = audio
    const started = performance.now()
    const from = audio.volume
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      audio.volume = from * (1 - progress)
      if (progress < 1) frame = requestAnimationFrame(step)
      else {
        clearAudio(audio)
        frame = 0
        if (fading === audio) fading = null
      }
    }
    frame = requestAnimationFrame(step)
  }

  return { stop, fadeOut }
}
