/*
 * frp-game 补丁：平台托管模式下的"登录态"。
 *
 * 上游原本走 WakuDemo OAuth（点「登录」跳第三方、回调写 cookie）。本平台要求
 * **麻将页的账号和平台首页账号是同一个**，而且页面不许再有第二个登录入口，
 * 所以托管时把身份来源换成服务端注入 `window.__FRP_ME__`（公开资料：id/名字/头像）。
 *
 * 后端也认平台身份：Node 网关把登录态写进 `x-frp-user-*` 头（见
 * games/mahjong/backend/app/api/deps.py），所以 REST/WebSocket 的身份与这里完全一致。
 * 没有托管（`__FRP_ME__` 不存在，比如上游自己部署）时保留原来的 OAuth 行为。
 */
import { ref } from 'vue'
import {
  beginWakuDemoLogin,
  getWakuDemoLoginSession,
  logoutWakuDemo,
  type WakuDemoAccount,
} from '../api/authApi'

interface FrpMe {
  id?: string
  name?: string
  avatar?: string
}

declare global {
  interface Window {
    __FRP_ME__?: FrpMe
  }
}

function platformMe(): FrpMe | null {
  if (typeof window === 'undefined') return null
  const me = window.__FRP_ME__
  return me && me.id ? me : null
}

export function useWakuDemoAuth() {
  const me = platformMe()
  const authenticated = ref(Boolean(me))
  const account = ref<WakuDemoAccount | null>(me ? {
    id: me.id ?? null,
    displayName: me.name ?? null,
    avatarUrl: me.avatar ?? null,
  } : null)
  const loading = ref(false)
  const error = ref('')

  async function refresh() {
    // 平台托管：身份是页面打开时注入的，运行期不会变；不重新请求。
    if (me) {
      loading.value = false
      return
    }
    loading.value = true
    try {
      const session = await getWakuDemoLoginSession()
      authenticated.value = session.authenticated
      account.value = session.authenticated ? session.account : null
    } catch {
      authenticated.value = false
      account.value = null
    } finally {
      loading.value = false
    }
  }

  function login() {
    if (me) {
      error.value = '账号就是平台账号：请回平台首页登录后再进入游戏。'
      return
    }
    error.value = ''
    beginWakuDemoLogin()
  }

  async function logout() {
    if (me) {
      error.value = '账号由平台首页统一管理，请回首页退出登录。'
      return
    }
    loading.value = true
    try {
      await logoutWakuDemo()
      authenticated.value = false
      account.value = null
      error.value = ''
    } catch {
      error.value = '退出登录失败，请稍后重试'
    } finally {
      loading.value = false
    }
  }

  void refresh()

  return { authenticated, account, loading, error, login, logout, refresh }
}