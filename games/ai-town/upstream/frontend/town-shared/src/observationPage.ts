/** 整页替换地图页的几个页面共用的显隐与轮询生命周期，内容渲染仍由各页负责。 */
export function observationPage(
  view: HTMLElement,
  observation: HTMLElement,
  request: () => void,
  pollMs: number | null = 2000,
  overlay = false
) {
  let open = false
  let poll: number | null = null
  const stopPolling = () => {
    if (poll !== null) window.clearInterval(poll)
    poll = null
  }
  return {
    isOpen: () => open,
    open() {
      open = true
      observation.hidden = !overlay
      if (overlay) observation.inert = true
      view.hidden = false
      request()
      stopPolling()
      if (pollMs !== null) poll = window.setInterval(request, pollMs)
    },
    close() {
      open = false
      stopPolling()
      view.hidden = true
      observation.hidden = false
      if (overlay) observation.inert = false
    },
  }
}
