// 内置模型的下载与更新：状态从管理服务的 /api/towns/builtin-model 来（host::builtin_store），首页设定、
// 小镇里的「模型服务」、开局向导和地图上等模型的提示条都看这一份。下载时每秒问一次进度，不下载时不问。
// 自动更新由页面来做：每次打开首页或进小镇时，离上次看清单超过 CHECK_EVERY 就再看一次（开着游戏不另外定时看），
// 有新版本、开着自动更新就在后台下；「检查更新」随时手动看。手机用流量时先问玩家；
// 玩家选「等连上 Wi-Fi」，或者自动更新碰上流量，就等连上 Wi-Fi 再下（这件事只记在页面里）。
import { button, el } from '../dom'
import { android, onBack } from '../platform'
import './builtin.css'

export interface BuiltinVersion {
  /** 发布日期；本机认不出来的模型为空 */
  date: string
  size: number
  notes: string
}
export type DownloadState =
  'running' | 'verifying' | 'paused' | 'error-net' | 'error-space' | 'error-file'
export interface BuiltinDownload extends BuiltinVersion {
  done: number
  state: DownloadState
  /** 被打断的（应用关掉过），不是玩家点的暂停：可以自己接着下 */
  resume: boolean
  need: number
  free: number
}
export interface BuiltinStatus {
  /** 应用带着推理程序 */
  supported: boolean
  installed: BuiltinVersion | null
  latest: BuiltinVersion | null
  /** 有比在用的更新的版本 */
  update: boolean
  /** 更新的版本要配新版游戏 */
  needs_app: BuiltinVersion | null
  checked_at: number | null
  auto: boolean
  download: BuiltinDownload | null
}

/** 打开游戏时，上次看清单超过这么久就再看一次 */
const CHECK_EVERY = 6 * 3600_000
const WIFI_KEY = 'town:builtin-wifi'

let status: BuiltinStatus | null = null
/** 正在看有没有新版本 */
let checking = false
/** 等连上 Wi-Fi 再下 */
let waitWifi = readWifi()
/** 一句刚发生的事（「刚检查过，已是最新」「已更新到 10 月 20 日版」），换掉版本那一行的说明，换了状态就不再提 */
let note = ''
let error = ''
let speed = 0
let sample: { at: number; done: number } | null = null
let timer = 0
const listeners = new Set<() => void>()
const finishers = new Set<(first: boolean) => void>()

function readWifi() {
  try {
    return localStorage.getItem(WIFI_KEY) === '1'
  } catch {
    return false
  }
}
function setWifi(on: boolean) {
  waitWifi = on
  try {
    if (on) localStorage.setItem(WIFI_KEY, '1')
    else localStorage.removeItem(WIFI_KEY)
  } catch {
    // 存不了就只在这次打开里等
  }
}

/** 现在用的是手机流量这类按量计费的网络；只有安卓应用壳答得上来 */
export function metered(): boolean {
  if (!android) return false
  try {
    const bridge = (window as unknown as { TownAndroid?: { metered?(): boolean } }).TownAndroid
    return !!bridge?.metered?.()
  } catch {
    return false
  }
}

async function call(body?: unknown): Promise<BuiltinStatus> {
  const response = await fetch('api/towns/builtin-model', {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Town-Client': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90000),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw Error(data?.error ?? `小镇服务返回 ${response.status}`)
  return data as BuiltinStatus
}

function emit() {
  for (const listener of listeners) listener()
}

/** 新状态到了：算下载速度，看是不是刚下完，决定还要不要接着问进度 */
function accept(next: BuiltinStatus) {
  const before = status
  status = next
  const d = next.download
  if (d?.state === 'running') {
    const now = Date.now()
    if (sample && d.done > sample.done) {
      const current = ((d.done - sample.done) / (now - sample.at)) * 1000
      speed = speed ? speed * 0.7 + current * 0.3 : current
    }
    sample = { at: now, done: d.done }
  } else {
    sample = null
    speed = 0
  }
  if (before?.download && !d && next.installed && before.download.date === next.installed.date) {
    const first = !before.installed
    note = first
      ? `${versionName(next.installed)} · 下好了，可以用了`
      : `已更新到${afterVerb(next.installed)}`
    for (const finish of finishers) finish(first)
  }
  clearTimeout(timer)
  if (d && ['running', 'verifying', 'error-net'].includes(d.state))
    timer = window.setTimeout(() => void refreshBuiltin(), 1000)
  // 心跳一时没跟上也会显示成被打断：再看几次，下载线程其实还在的话很快就接上了
  else if (d?.resume) timer = window.setTimeout(() => void refreshBuiltin(), 3000)
  else if (waitWifi) timer = window.setTimeout(() => void watchWifi(), 10000)
  emit()
}

/** 等 Wi-Fi 时隔一会儿看一眼，连上了就开始下 */
async function watchWifi() {
  if (!waitWifi) return
  if (metered()) {
    timer = window.setTimeout(() => void watchWifi(), 10000)
    return
  }
  setWifi(false)
  await act('download')
}

/** quiet：后台自己做的（打开游戏时看清单），出错不提，下次再试 */
async function act(action: string, extra: Record<string, unknown> = {}, quiet = false) {
  error = ''
  try {
    accept(await call({ action, ...extra }))
  } catch (e) {
    if (!quiet) error = e instanceof Error ? e.message : String(e)
    emit()
  }
}

export function builtinStatus() {
  return status
}

/** 在等连上 Wi-Fi 再下 */
export const builtinWaitingWifi = () => waitWifi

/** 状态变了（进度、下完、出错）时回调；返回取消订阅的函数 */
export function onBuiltin(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 下载刚完成时回调；first 表示这是第一次装上（不是更新） */
export function onBuiltinInstalled(listener: (first: boolean) => void) {
  finishers.add(listener)
  return () => finishers.delete(listener)
}

export async function refreshBuiltin() {
  try {
    accept(await call())
  } catch {
    // 管理服务太旧没有这个接口，或者一时连不上：当没有内置模型
  }
  return status
}

let lastAsked = 0
/** 页面记的状态可能旧了（比如在别的页面删了模型）：隔几秒最多问一次 */
export function refreshBuiltinSoon() {
  if (Date.now() - lastAsked < 5000) return
  lastAsked = Date.now()
  void refreshBuiltin()
}

/** 看有没有新版本（「检查更新」，也是自动更新的第一步） */
export async function checkBuiltin() {
  checking = true
  note = ''
  emit()
  await act('check')
  checking = false
  if (!error && status?.installed && !status.update)
    note = `${versionName(status.installed)} · 刚检查过，${status.needs_app ? '这个游戏版本能用的最新版' : '已是最新'}`
  emit()
  // 开着自动更新：查到新版本就接着下，和打开游戏时一样
  if (status?.update && status.auto && !status.download) await updateInBackground()
}

/** 自动更新的下载：手机用流量时不问，等连上 Wi-Fi */
async function updateInBackground() {
  if (metered()) {
    setWifi(true)
    if (status) accept(status)
  } else await act('download')
}

/** 玩家点下载、更新、继续、重试。手机用流量时先问一句 */
export async function downloadBuiltin() {
  note = ''
  if (metered() && !(await askCellular())) {
    setWifi(true)
    accept(status ?? (await call()))
    return
  }
  setWifi(false)
  await act('download')
}

/** 不问流量，直接下（「用流量下载」） */
export async function downloadBuiltinNow() {
  setWifi(false)
  note = ''
  await act('download')
}

export const pauseBuiltin = () => act('pause')
export const deleteBuiltin = async () => {
  setWifi(false)
  note = ''
  await act('delete')
}
export const setBuiltinAuto = (on: boolean) => act('auto', { on })

/**
 * 打开游戏时调用一次：被打断的下载接着下，等 Wi-Fi 的看看连上没有，开着自动更新就看有没有新版本、
 * 有就在后台下。第一次下载要玩家自己点，这里不替他下。
 */
export async function autoUpdateBuiltin() {
  const s = await refreshBuiltin()
  if (!s?.supported) return
  const d = s.download
  if (d?.state === 'paused' && d.resume) {
    if (metered()) setWifi(true)
    else await act('download')
    return
  }
  if (waitWifi) return void watchWifi()
  if (d) return
  const due = !s.checked_at || Date.now() - s.checked_at > CHECK_EVERY
  // 还没下载时也看一眼清单：提示里要写多大
  if (!s.installed) {
    if (due) await act('check', {}, true)
    return
  }
  if (!s.auto) return
  if (due) await act('check', {}, true)
  if (status?.update && !status.download) await updateInBackground()
}

/** 「10 月 8 日版」；本机认不出来的模型叫「本机的模型」 */
export function versionName(v: BuiltinVersion | null | undefined) {
  const m = v?.date.match(/^\d{4}-(\d{2})-(\d{2})$/)
  return m ? `${Number(m[1])} 月 ${Number(m[2])} 日版` : '本机的模型'
}

/** 接在汉字后面的版本名：数字开头的前面空一格（「照常用 10 月 8 日版」） */
function afterVerb(v: BuiltinVersion | null | undefined) {
  const name = versionName(v)
  return /^\d/.test(name) ? ` ${name}` : name
}

export const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`

function remaining(d: BuiltinDownload) {
  if (!speed) return ''
  const seconds = Math.ceil((d.size - d.done) / speed)
  return seconds >= 60
    ? ` · 还要约 ${Math.ceil(seconds / 60)} 分钟`
    : ` · 还要约 ${Math.max(1, seconds)} 秒`
}

/** 「196 / 530 MB · 还要约 30 秒」 */
export function bytesText(d: BuiltinDownload) {
  return `${Math.round(d.done / 1e6)} / ${megabytes(d.size)}${remaining(d)}`
}

export function percent(d: BuiltinDownload) {
  return d.size ? Math.floor((d.done / d.size) * 100) : 0
}

/** 「37% · 196 / 530 MB · 还要约 30 秒」 */
export function progressText(d: BuiltinDownload) {
  return `${percent(d)}% · ${Math.round(d.done / 1e6)} / ${megabytes(d.size)}${remaining(d)}`
}

/** 设定里这一行怎么写：圆点、小标签、说明、补充一句、进度、按钮 */
export interface BuiltinView {
  dot: 'ok' | 'busy' | 'off' | 'danger'
  chip: { tone: '' | 'ok' | 'busy' | 'info' | 'danger'; text: string }
  desc: string
  tone?: 'ok' | 'danger'
  extra?: string
  /** 0–1；没有在下载时为 undefined */
  meter?: number
  action?: { label: string; run: () => void; disabled?: boolean }
}

/**
 * 按现在的状态写这一行。swap 是小镇里才有的：新版是小镇开着时下好的，推理服务还在用旧的。
 * 状态还没读到、应用没带推理程序时为 null。
 */
export function builtinView(swap?: {
  restart: () => void
  restarting: boolean
}): BuiltinView | null {
  const s = status
  if (!s?.supported) return null
  const have = s.installed
  const d = s.download
  const using = have ? `下完之前照常用${afterVerb(have)}。` : undefined
  if (error)
    return {
      dot: have ? 'ok' : 'danger',
      chip: { tone: 'danger', text: '出错了' },
      tone: 'danger',
      desc: error,
      action: { label: '重试', run: () => void (d ? downloadBuiltin() : checkBuiltin()) },
    }
  if (d) {
    const meter = d.size ? d.done / d.size : 0
    switch (d.state) {
      case 'running':
        return have
          ? {
              dot: 'ok',
              chip: { tone: 'busy', text: `更新中 ${percent(d)}%` },
              desc: `正在下载${afterVerb(d)} · ${progressText(d)}`,
              extra: using,
              meter,
              action: { label: '暂停', run: () => void pauseBuiltin() },
            }
          : {
              dot: 'busy',
              chip: { tone: 'busy', text: `下载中 ${percent(d)}%` },
              desc: `下载中 · ${progressText(d)}`,
              meter,
              action: { label: '暂停', run: () => void pauseBuiltin() },
            }
      case 'verifying':
        return {
          dot: have ? 'ok' : 'busy',
          chip: { tone: 'busy', text: '检查文件' },
          desc: '下载好了，正在检查文件…',
          meter: 1,
        }
      case 'paused':
        if (waitWifi) break
        return {
          dot: have ? 'ok' : 'off',
          chip: { tone: '', text: `已暂停 ${percent(d)}%` },
          desc: `已暂停 · 下了 ${percent(d)}%（${Math.round(d.done / 1e6)} / ${megabytes(d.size)}）`,
          extra: using,
          meter,
          action: { label: '继续', run: () => void downloadBuiltin() },
        }
      case 'error-net':
        return {
          dot: have ? 'ok' : 'danger',
          chip: { tone: 'danger', text: '没下完' },
          tone: 'danger',
          desc: `没下完：连不上下载服务器。已下的 ${percent(d)}% 会留着，连上网后自动接着下。`,
          extra: have ? `现在照常用${afterVerb(have)}。` : undefined,
          action: { label: '重试', run: () => void downloadBuiltin() },
        }
      case 'error-space':
        return {
          dot: have ? 'ok' : 'danger',
          chip: { tone: 'danger', text: '空间不够' },
          tone: 'danger',
          desc: `空间不够：还需要 ${megabytes(d.need)}，这台设备只剩 ${megabytes(d.free)}。清出空间后点重试。`,
          action: { label: '重试', run: () => void downloadBuiltin() },
        }
      case 'error-file':
        return {
          dot: have ? 'ok' : 'danger',
          chip: { tone: 'danger', text: '没下好' },
          tone: 'danger',
          desc: '下载的文件对不上，已经删掉了。点重试重新下载。',
          action: { label: '重试', run: () => void downloadBuiltin() },
        }
    }
  }
  if (waitWifi)
    return have
      ? {
          dot: 'ok',
          chip: { tone: 'info', text: '有新版本' },
          desc: `有新版本：${versionName(s.latest)} · 连上 Wi-Fi 后自动下载`,
          extra: s.latest?.notes ? `这一版：${s.latest.notes}` : undefined,
          action: { label: '用流量下载', run: () => void downloadBuiltinNow() },
        }
      : {
          dot: 'off',
          chip: { tone: '', text: '等 Wi-Fi' },
          desc: `等连上 Wi-Fi 就开始下载${s.latest ? ` · ${megabytes(s.latest.size)}` : ''}`,
          action: { label: '用流量下载', run: () => void downloadBuiltinNow() },
        }
  if (!have)
    return {
      dot: 'off',
      chip: { tone: '', text: '未下载' },
      desc: s.latest
        ? `免费，在这台设备上运行 · 先要下载 ${megabytes(s.latest.size)}`
        : '免费，在这台设备上运行，用之前要先下载',

      action: { label: '下载', run: () => void downloadBuiltin() },
    }
  if (swap)
    return {
      dot: swap.restarting ? 'busy' : 'ok',
      chip: { tone: 'info', text: '新版本已下好' },
      desc: swap.restarting
        ? `正在换上${afterVerb(have)}，村民稍等一下…`
        : `${versionName(have)}已下载好，下次进小镇时换上`,
      extra: '现在换上的话，村民会停十几秒，等新模型载入。',
      action: { label: '现在换上', run: swap.restart, disabled: swap.restarting },
    }
  const check = { label: '检查更新', run: () => void checkBuiltin(), disabled: checking }
  if (checking)
    return {
      dot: 'ok',
      chip: { tone: 'ok', text: '可以用' },
      desc: '正在看有没有新版本…',
      action: check,
    }
  if (s.update)
    return {
      dot: 'ok',
      chip: { tone: 'info', text: '有新版本' },
      desc: `有新版本：${versionName(s.latest)} · ${megabytes(s.latest?.size ?? 0)}`,
      extra: s.latest?.notes ? `这一版：${s.latest.notes}` : undefined,
      action: { label: '更新', run: () => void downloadBuiltin() },
    }
  return {
    dot: 'ok',
    chip: { tone: 'ok', text: '可以用' },
    tone: note ? 'ok' : undefined,
    desc: note || `${versionName(have)} · ${s.needs_app ? '这个游戏版本能用的最新版' : '已是最新'}`,
    extra: s.needs_app ? '有更新的内置模型，要先把游戏更新到新版本才能用。' : undefined,
    action: check,
  }
}

/** 有新版本、没开自动更新：首页「设定」上亮一个小绿点 */
export function builtinNeedsAttention() {
  return (
    !!status?.supported && !!status.installed && status.update && !status.auto && !status.download
  )
}

/** 内置模型能不能用（文件已经下好）；应用没带推理程序时为 false */
export function builtinReady() {
  return !!status?.supported && !!status.installed
}

/** 手机用流量时问一句：true 用流量下，false 等 Wi-Fi */
function askCellular(): Promise<boolean> {
  return new Promise((resolve) => {
    const size = status?.download?.size ?? status?.latest?.size ?? 0
    const dialog = el('dialog', '', 'builtin-ask')
    dialog.setAttribute('aria-label', '正在用手机流量')
    const card = el('div', '', 'builtin-ask-card')
    const actions = el('div', '', 'builtin-ask-actions')
    let answer = false
    const close = (value: boolean) => {
      answer = value
      dialog.close()
    }
    actions.append(
      button('等连上 Wi-Fi', () => close(false)),
      button('用流量下载', () => close(true), 'primary')
    )
    card.append(
      el('h3', '正在用手机流量'),
      el(
        'p',
        `内置模型有 ${size ? megabytes(size) : '几百 MB'}。连上 Wi-Fi 再下更省流量；下到一半断了也会接着下，不用从头来。`
      ),
      actions
    )
    dialog.append(card)
    document.body.append(dialog)
    const offBack = onBack(() => {
      close(false)
      return true
    })
    dialog.addEventListener('close', () => {
      offBack()
      dialog.remove()
      resolve(answer)
    })
    dialog.showModal()
  })
}
