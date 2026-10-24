/*
 * 无名杀 ↔ 平台 的桥接脚本。
 *
 * 它是**服务端注入**到 `/noname/index.html` 里的一行 <script type="module"> 加载的
 * （见 server/http.mjs 的 sendInjectedNonameIndex），**不在 dist 里** ——
 * 所以上游更新 / `pnpm build` 都不会把它冲掉，不需要改无名杀的源码。
 *
 * 它做四件事（用户要求的三条 + 一条保命）：
 *   1. 身份绑定：把平台的昵称、头像写进无名杀的「联机昵称 / 联机头像」，
 *      并补一层 `setBackground` 兼容，让**图片头像 URL** 在无名杀里也能显示。
 *   2. 选项 → 联机：加一行「邀请平台好友」，弹平台好友列表，选中后发邀请。
 *   3. 在线状态：每 15 秒把「我在哪个无名杀房间 / 是否开局」告诉平台，
 *      平台好友于是能看到「正在玩 无名杀（三国杀）」并点「进入 / 观战」。
 *   4. `?frpJoin=<房号>` 深链：从平台点好友的房间时直接进房（开局了就尝试观战）。
 *
 * ⚠️ 无名杀页面**没有平台的 WebSocket**（它是另一个网页），所以这里全部走
 *    `/api/*` 的 fetch（同一个 HttpOnly 会话 cookie）。服务端在打开 `/noname/`
 *    时已经验过登录，没登录的会被 302 回平台登录页。
 *
 * ⚠️ 不要在 dist 里引用这个文件，也不要把逻辑挪进 dist：改这里只要刷新生效。
 */
import { game, get, lib, ui, _status } from 'noname';

const ME_POLL_MS = 60_000;       // 多久重新确认一次平台头像/昵称
const STATE_POLL_MS = 3_000;     // 多久看一眼自己在不在房间（状态一变立刻上报）
const HEARTBEAT_MS = 15_000;     // 心跳：即使状态没变也要续期（服务端 45 秒过期）
const FRIEND_URL = '/api/noname/friends';
const STATE_URL = '/api/noname/state';
const INVITE_URL = '/api/noname/invite';

let me = null;
let lastState = '';
let lastSentAt = 0;
let lastRoom = '';
let joinTimer = null;

/* ============================== 小工具 ============================== */

function platformLogin() {
  const back = encodeURIComponent(location.pathname + location.search);
  location.replace('/?return=' + back);
}

async function api(path, options) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
  });
  if (res.status === 401) {
    platformLogin();
    throw new Error('未登录');
  }
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error('服务端返回了非 JSON 内容（HTTP ' + res.status + '）');
  }
  if (!res.ok || data.ok === false) throw new Error(data.message || '请求失败');
  return data;
}

/** 名字前两位（按码点，不切坏 emoji）。 */
function initials(name) {
  return [...String(name || '?')].slice(0, 2).join('');
}

/* ============================== 1. 身份绑定 ============================== */

/*
 * 无名杀把联机头像当成「武将名」，交给 `setBackground(name, "character")` 去拼图片路径。
 * 我们塞进去的是平台地址（`/avatar/<id>?v=…`），原生逻辑会把它拼成
 * `/noname//avatar/…` 这种不存在的路径，结果就是头像全空。
 *
 * 所以在这里补一层：只要名字长得像平台头像地址，就直接当背景图用；
 * 其余（普通武将名）原样交回上游。这是纯增量，不影响单机武将立绘。
 */
function patchSetBackground() {
  const proto = window.HTMLDivElement && window.HTMLDivElement.prototype;
  if (!proto || proto.__frpAvatarPatched) return true;
  const original = proto.setBackground;
  // 桥接脚本比无名杀的 polyfill 先跑：返回 false，由启动逻辑轮询重试
  if (typeof original !== 'function') return false;
  proto.setBackground = function (name, type, ext, subfolder) {
    if (typeof name === 'string' && name.startsWith('/avatar/')) {
      this.style.backgroundImage = 'url("' + name.replace(/"/g, '%22') + '")';
      this.style.backgroundSize = 'cover';
      this.style.backgroundPosition = 'center';
      this.style.backgroundRepeat = 'no-repeat';
      return this;
    }
    return original.call(this, name, type, ext, subfolder);
  };
  proto.__frpAvatarPatched = true;
  return true;
}

function applyIdentity() {
  if (!me) return;
  // 无名杀自己的菜单还没建好 = 它还没读完本地配置，这时候写进去会被它覆盖
  if (!ui.menuContainer) return;
  try {
    // 无名杀会在 12 个字符处自己再截一次；平台名字上限 10，够用
    game.saveConfig('connect_nickname', me.name);
    game.saveConfig('connect_nickname', me.name, 'connect');
    game.saveConfig('connect_avatar', me.avatar, 'connect');
    game.saveConfig('connect_avatar', me.avatar);
  } catch (err) {
    console.warn('[平台] 同步无名杀昵称/头像失败', err);
  }
  if (typeof get.config === 'function') {
    // 已经在大厅/房间里的人：把新头像立刻广播给同房的人
    try {
      if (game.online || game.onlinehall) {
        game.send('server', 'changeAvatar', get.connectNickname(), lib.config.connect_avatar);
      }
    } catch (err) {
      /* 没连上就等下一次进大厅时自然带上 */
    }
  }
}

async function loadMe() {
  const data = await api('/api/me');
  const next = data.me;
  const changed = !me || me.name !== next.name || me.avatar !== next.avatar;
  me = next;
  window.__frpMe = me;
  if (changed) applyIdentity();
}

/* ============================== 2. 邀请好友 ============================== */

function ensureStyle() {
  if (document.getElementById('frp-noname-style')) return;
  const style = document.createElement('style');
  style.id = 'frp-noname-style';
  style.textContent = `
    /*
     * ⚠️ 无名杀的全局样式是 div { display: inline-block; position: absolute; }。
     * 我们的弹窗虽然插在 body 下，但卡片/头/脚也是 div —— 不显式改回 relative，
     * 它们就会脱离 flex 流，脚上的「关闭 / 发送邀请」直接盖在好友列表上。
     * 所以下面每个参与排版的 div 都必须有 position:relative，且列表要 min-height:0
     * 才能真正滚动、而不是被内容撑破后顶到脚上。
     */
    .frp-noname-mask {
      position: fixed; inset: 0; z-index: 2147483647; isolation: isolate;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.62); padding: 18px;
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #eef1f6; overflow: hidden;
    }
    .frp-noname-card, .frp-noname-head, .frp-noname-foot,
    .frp-noname-list, .frp-noname-friend, .frp-noname-msg,
    .frp-noname-btn, .frp-noname-close {
      box-sizing: border-box; position: relative;
    }
    .frp-noname-card {
      width: min(420px, 100%); max-height: min(76vh, 620px);
      display: flex; flex-direction: column;
      background: #1d2026; border: 1px solid #343945; border-radius: 14px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5); overflow: hidden;
    }
    .frp-noname-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 14px 16px; border-bottom: 1px solid #343945;
      flex: none;
    }
    .frp-noname-head strong { font-size: 16px; }
    .frp-noname-close {
      min-width: 44px; min-height: 44px; border: 0; border-radius: 10px;
      background: transparent; color: #cfd6e4; font-size: 20px; cursor: pointer;
      flex: none;
    }
    .frp-noname-close:hover { background: #2a2f39; }
    .frp-noname-list {
      list-style: none; margin: 0; padding: 8px; overflow-y: auto; flex: 1 1 auto;
      min-height: 0; -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
    }
    .frp-noname-friend {
      display: flex; align-items: center; gap: 10px;
      min-height: 52px; padding: 6px 8px; border-radius: 10px;
    }
    .frp-noname-friend:hover { background: #262b34; }
    .frp-noname-friend input {
      width: 22px; height: 22px; flex: none; accent-color: #4a9dff;
      position: relative;
    }
    .frp-noname-avatar {
      width: 38px; height: 38px; border-radius: 50%; object-fit: cover;
      flex: none; background: #2a2f39; position: relative;
    }
    .frp-noname-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .frp-noname-online { font-size: 12px; color: #46c07a; flex: none; margin-left: auto; }
    .frp-noname-offline { font-size: 12px; color: #8b93a3; flex: none; margin-left: auto; }
    .frp-noname-foot {
      padding: 12px 16px; border-top: 1px solid #343945;
      display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
      flex: none;
    }
    .frp-noname-msg { flex: 1 1 100%; min-height: 18px; color: #ffd166; font-size: 13px; }
    .frp-noname-btn {
      min-height: 44px; padding: 8px 18px; border-radius: 10px; cursor: pointer;
      border: 1px solid #3a4050; background: #262b34; color: #eef1f6; font: inherit;
    }
    .frp-noname-btn:disabled { opacity: 0.55; cursor: default; }
    .frp-noname-btn.primary { background: #2f6fd0; border-color: #3f83ea; }
    .frp-noname-toast {
      position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
      z-index: 2147483647; max-width: min(90vw, 460px);
      padding: 12px 18px; border-radius: 12px;
      background: rgba(24, 27, 33, 0.96); border: 1px solid #3a4050;
      color: #eef1f6; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    }
  `;
  document.head.appendChild(style);
}

function toast(text, ms) {
  ensureStyle();
  const node = document.createElement('div');
  node.className = 'frp-noname-toast';
  node.textContent = text;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), ms || 3200);
}

function closeDialog(mask) {
  mask.remove();
  document.removeEventListener('keydown', mask.__esc);
}

function openInviteDialog() {
  ensureStyle();
  const mask = document.createElement('div');
  mask.className = 'frp-noname-mask';
  const room = game.roomId || lastRoom;
  mask.innerHTML = `
    <div class="frp-noname-card" role="dialog" aria-modal="true" aria-label="邀请平台好友">
      <div class="frp-noname-head">
        <strong>邀请平台好友</strong>
        <button class="frp-noname-close" type="button" aria-label="关闭">×</button>
      </div>
      <ul class="frp-noname-list"><li class="frp-noname-friend">正在读取好友…</li></ul>
      <div class="frp-noname-foot">
        <div class="frp-noname-msg"></div>
        <button class="frp-noname-btn" type="button" data-close>关闭</button>
        <button class="frp-noname-btn primary" type="button" data-send disabled>发送邀请</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.__esc = (event) => { if (event.key === 'Escape') closeDialog(mask); };
  document.addEventListener('keydown', mask.__esc);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) closeDialog(mask);
  });
  mask.querySelector('.frp-noname-close').addEventListener('click', () => closeDialog(mask));
  mask.querySelector('[data-close]').addEventListener('click', () => closeDialog(mask));

  const list = mask.querySelector('.frp-noname-list');
  const msg = mask.querySelector('.frp-noname-msg');
  const send = mask.querySelector('[data-send]');
  const checks = [];

  if (!room) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'frp-noname-friend';
    li.textContent = '你还没建房或进房。先在无名杀里开一个房间，再回来点这一行。';
    list.appendChild(li);
    return;
  }

  api(FRIEND_URL).then((data) => {
    const friends = data.list || [];
    list.innerHTML = '';
    if (!friends.length) {
      const li = document.createElement('li');
      li.className = 'frp-noname-friend';
      li.textContent = '你还没有好友。在平台「好友」栏按 ID 加一个吧。';
      list.appendChild(li);
      return;
    }
    friends.forEach((friend) => {
      const li = document.createElement('li');
      li.className = 'frp-noname-friend';

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.value = friend.id;
      check.checked = Boolean(friend.online && friend.playing && friend.playing.game === 'noname'
        && friend.playing.code === room);
      check.setAttribute('aria-label', '邀请 ' + friend.name);
      checks.push(check);

      const img = document.createElement('img');
      img.className = 'frp-noname-avatar';
      img.alt = '';
      img.src = friend.avatar || '/avatar/' + encodeURIComponent(friend.id);
      img.addEventListener('error', () => {
        // 图片挂了就退回"名字首字"的圆片，别留一个破图标
        const fallback = document.createElement('span');
        fallback.className = 'frp-noname-avatar';
        fallback.style.cssText += 'display:inline-flex;align-items:center;justify-content:center;color:#cfd6e4;font-size:14px;';
        fallback.textContent = initials(friend.name);
        img.replaceWith(fallback);
      });

      const name = document.createElement('span');
      name.className = 'frp-noname-name';
      name.textContent = friend.name;

      const state = document.createElement('span');
      state.className = friend.online ? 'frp-noname-online' : 'frp-noname-offline';
      state.textContent = friend.online ? '在线' : '离线';

      li.append(check, img, name, state);
      list.appendChild(li);
    });
    updateSend();
  }).catch((err) => {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'frp-noname-friend';
    li.textContent = '好友列表读不出来：' + err.message;
    list.appendChild(li);
  });

  function updateSend() {
    send.disabled = !checks.some((c) => c.checked);
  }
  list.addEventListener('change', updateSend);

  send.addEventListener('click', async () => {
    const to = checks.filter((c) => c.checked).map((c) => c.value);
    if (!to.length) return;
    send.disabled = true;
    msg.textContent = '正在发送…';
    try {
      const mode = lib.configOL && lib.configOL.mode ? (lib.translate[lib.configOL.mode] || lib.configOL.mode) : '';
      const data = await api(INVITE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: room, mode: mode, to: to }),
      });
      msg.textContent = data.message || ('已发给 ' + data.sent + ' 位好友，他们平台首页上会弹出邀请。');
      checks.forEach((c) => { c.checked = false; });
    } catch (err) {
      msg.textContent = '没发出去：' + err.message;
    } finally {
      updateSend();
    }
  });
}

/**
 * 把「邀请平台好友」加到 选项 → 联机 那一页。
 *
 * 无名杀会建**两套菜单**：主菜单一套、进了联机模式又一套。所以这里不是"插一次就完"，
 * 而是持续盯着 —— 哪套菜单的联机配置页出现了，就给它补一行；重复调用是幂等的。
 */
function addInviteRow() {
  let added = false;
  const categories = document.querySelectorAll('.menubutton.large');
  for (const category of categories) {
    if (category.mode !== 'connect' || !category.link) continue;
    if (category.link.querySelector('.frp-noname-invite')) continue;
    const row = document.createElement('div');
    row.className = 'config frp-noname-invite';
    row.style.cssText = 'color:#ffd166;font-weight:700;';
    const span = document.createElement('span');
    span.className = 'pointerdiv';
    span.textContent = '邀请平台好友';
    row.appendChild(span);
    let lastTouch = 0;
    row.addEventListener('click', (event) => {
      // touchend 已经处理过的那次 click 不再重复弹
      if (Date.now() - lastTouch < 700) return;
      event.preventDefault();
      event.stopPropagation();
      openInviteDialog();
    });
    // 无名杀在手机上主要靠 touchend（它自己的 listen 也是这么接的），补一份防漏
    row.addEventListener('touchend', (event) => {
      lastTouch = Date.now();
      event.preventDefault();
      event.stopPropagation();
      openInviteDialog();
    });
    category.link.appendChild(row);
    added = true;
  }
  return added;
}

function watchMenu() {
  // 菜单一出现就把样式挂上（体检也会用同一套 class 量弹窗盒子）
  ensureStyle();
  addInviteRow();
  // 菜单重建次数很少（开局/联机各一次），监听整棵文档的代价可以接受
  const observer = new MutationObserver(() => addInviteRow());
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

/* ============================== 3. 在线状态 ============================== */

function roomState() {
  // 不在联机相关界面 → 没在玩，清掉状态（服务端 45 秒 TTL 只是兜底）
  if (!game.online && !game.onlinehall && !game.roomId && !game.observe) {
    lastRoom = '';
    return { room: '' };
  }
  if (game.roomId) lastRoom = String(game.roomId);
  // 观战成功时 roomId 被上游清成 null，但 autoJoin 把房号写进了 tmp_user_roomId。
  // 只在**确实进入观战**（observe=true）时才认它 —— 否则人还在大厅就会误报"在房里"。
  if (!game.roomId && game.observe && !lastRoom) {
    const tmp = String((lib.config && lib.config.tmp_user_roomId) || '');
    if (/^[A-Za-z0-9]{1,32}$/.test(tmp)) lastRoom = tmp;
  }

  /*
   * 观战的人 `game.roomId` 会被上游清成 null（reinit(observe=true) 那一段），
   * 但他人确实还在房间里，所以用之前记下的房号继续上报 —— 否则好友列表会闪一下"不在了"。
   */
  const room = game.roomId || (game.observe ? lastRoom : '');
  if (!room) {
    lastRoom = '';
    return { room: '' };
  }

  const cfg = lib.configOL || {};
  const started = Boolean(_status.gameStarted) || (typeof game.phaseNumber === 'number' && game.phaseNumber > 0);
  const observe = Boolean(game.observe) || Boolean(cfg.observe);
  let count = 0;
  try {
    if (Array.isArray(game.connectPlayers)) {
      count = game.connectPlayers.filter((p) => !p.classList.contains('unselectable2')).length;
    } else if (cfg.number) {
      count = Number(cfg.number) || 0;
    }
  } catch (err) {
    count = 0;
  }
  return {
    room: String(room),
    mode: cfg.mode ? (lib.translate[cfg.mode] || cfg.mode) : '',
    started: started,
    observe: observe,
    count: count,
  };
}

async function sendState(force) {
  const state = roomState();
  const key = JSON.stringify(state);
  const due = Date.now() - lastSentAt >= HEARTBEAT_MS;
  if (!force && key === lastState && !due) return;
  lastState = key;
  lastSentAt = Date.now();
  try {
    await api(STATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state),
    });
  } catch (err) {
    // 断网/掉登录：下一次心跳会再试；401 已经在 api() 里回登录页了
  }
}

/* ============================== 4. 深链进房 ============================== */

function readJoinCode() {
  const params = new URLSearchParams(location.search);
  return params.get('frpJoin') || '';
}

/**
 * `?frpJoin=<房号>`：从平台点好友的「进入 / 观战」时直接进房。
 *
 * 无名杀自己的机制是：把房号写进 `tmp_user_roomId`，大厅的 roomlist 到了就自动 enter。
 * 所以这里只需要（1）写房号（2）替用户点一下「联机大厅」——
 * 房号必须在**连上大厅之前**写好，否则 roomlist 已经过去了、房号没人消费。
 *
 * 这条路径**不刷页面**：只是驱动无名杀自己的 UI，用户看到的和手点一样。
 */
function waitFor(test, timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let value = null;
      try { value = test(); } catch (err) { value = null; }
      if (value) return resolve(value);
      if (Date.now() - started > timeout) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function autoJoin(code) {
  sessionStorage.setItem('frp.noname.armed', code);
  console.info('[平台] 自动进房开始', code, 'url=' + location.href);

  // 等无名杀自己初始化完（`ui.window` 在；主菜单在"联机模式直接启动"时可能没有）
  const ready = await waitFor(() => ui.window && lib.mode && lib.mode.connect, 30_000);
  if (!ready) {
    toast('无名杀还没加载完，自动进房放弃了；请手动进「联机」再进房间。', 5000);
    return;
  }
  console.info('[平台] 自动进房：初始化就绪', {
    mode: lib.config.mode,
    online: Boolean(game.online),
    onlinehall: Boolean(game.onlinehall),
    onlineroom: Boolean(game.onlineroom),
  });

  // 新手引导/演示局不再手动点：roomlist 一到 game.clearArena() 会收掉；
  // 去点「跳过向导 / 退出」反而会卡住教程的异步流程或丢掉 ?frpJoin=。

  const hallURL = lib.hallURL
    || (get.config && get.config('hall_ip'))
    || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/noname-online`;

  // roomlist 一到就消费这个房号；必须**在连接之前**写好
  game.saveConfig('tmp_user_roomId', code);

  // 直接 game.connect 跳过了联机模式初始化，lib.configOL 还是空的；
  // roomlist → clearArena → ui.create.cards 会读 bannedcards，不补会抛异常。
  if (lib.configOL) {
    lib.configOL.mode = lib.configOL.mode || lib.config.connect_mode || 'identity';
    lib.configOL.banned = lib.configOL.banned || [];
    lib.configOL.bannedcards = lib.configOL.bannedcards || [];
  }

  // 进房前把平台名字/头像直接写进联机配置（connect 模式下 applyIdentity 可能没跑）
  if (me) {
    try {
      game.saveConfig('connect_nickname', me.name);
      game.saveConfig('connect_nickname', me.name, 'connect');
      game.saveConfig('connect_avatar', me.avatar, 'connect');
      game.saveConfig('connect_avatar', me.avatar);
    } catch (err) {
      console.warn('[平台] 进房前同步昵称/头像失败', err);
    }
  }

  const enter = () => {
    try {
      game.send('server', 'enter', code, get.connectNickname(), lib.config.connect_avatar);
    } catch (err) {
      /* 房间不存在/已开局时服务端会拒绝，下面超时提示兜底 */
    }
  };

  if (game.online || game.onlinehall) {
    // 已经在大厅（比如页面没刷新过）：直接补一条 enter
    enter();
  } else {
    // connect 模式里那段 `onlineKey` 初始化，直接连的时候得自己补上
    if (!game.onlineKey) {
      game.onlineKey = localStorage.getItem(`${lib.configprefix}key`);
      if (!game.onlineKey) {
        game.onlineKey = get.id();
        localStorage.setItem(`${lib.configprefix}key`, game.onlineKey);
      }
    }
    try {
      game.connect(hallURL, (success) => {
        console.info('[平台] 自动进房：WebSocket 打开 =', success);
        if (!success) toast('连不上联机服务器，请稍后重试。', 5000);
      });
    } catch (err) {
      console.warn('[平台] 自动进房连接失败', err);
      toast('连不上联机服务器，请稍后重试。', 5000);
    }
  }

  // 等大厅握手（roomlist）到达；到了就会自动 enter 我们的房号
  const connected = await waitFor(() => game.online || game.onlinehall, 12_000);
  console.info('[平台] 自动进房：大厅握手 =', connected, 'room =', game.roomId || '');
  if (!connected) {
    toast('联机服务器没连上（隧道可能断了），请稍后从「联机」重试。', 5200);
  }

  // 极端情况：大厅已经连上，但 roomlist 早于 tmp_user_roomId 被消费 —— 补一条 enter
  if (connected && !game.roomId && !game.observe) {
    await sleep(1200);
    if (!game.roomId && !game.observe) enter();
  }

  // 20 秒还没进去：房间可能解散了，或已开局且房主没开「允许观战」。
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    if (game.roomId || game.observe) return;
    sessionStorage.removeItem('frp.noname.join');
    sessionStorage.removeItem('frp.noname.armed');
    clearJoinFromUrl();
    toast('没进得去：房间可能已解散，或者已经开局但房主没开「允许观战」。', 5200);
  }, 20_000);
}

function clearJoinFromUrl() {
  if (!readJoinCode()) return;
  try {
    history.replaceState(null, '', location.pathname + location.hash);
  } catch (err) {
    /* 老浏览器不支持就算了 */
  }
}

function watchRoomEntered() {
  const clearIntro = () => {
    if (!/跳过向导/.test(document.body ? document.body.innerText : '')) return;
    /*
     * 只把向导「藏起来」，**不点跳过、也不 close**。
     * 点跳过 / close 都会让身份局教程继续走清场或 reload，把刚进的房间冲掉；
     * 教程 Promise 悬着没关系，房间界面已经接管了。
     */
    try {
      if (ui.dialog) ui.dialog.style.display = 'none';
      if (ui.dialog && ui.dialog.parentNode && ui.dialog.parentNode.classList.contains('dialog')) {
        ui.dialog.parentNode.style.display = 'none';
      }
      if (Array.isArray(ui.controls)) {
        ui.controls.forEach((control) => { control.style.display = 'none'; });
      }
    } catch (err) {
      /* 藏不掉也不挡进房 */
    }
  };

  const check = () => {
    // 观战成功时 `game.roomId` 是 null，只有 `game.observe` —— 别把它当成"没进去"
    if (!game.roomId && !game.observe) return;
    sessionStorage.removeItem('frp.noname.join');
    sessionStorage.removeItem('frp.noname.armed');
    clearJoinFromUrl();
    clearTimeout(joinTimer);
    // 首次打开的人可能在房间里还盖着「欢迎来到无名杀」的新手向导，把它藏起来
    clearIntro();
    setTimeout(clearIntro, 500);
    setTimeout(clearIntro, 1500);
  };
  check();
  setInterval(check, 2000);
}

/* ============================== 启动 ============================== */

function interceptFailedJoin() {
  if (window.__frpAlertPatched) return;
  window.__frpAlertPatched = true;

  const originalAlert = window.alert;
  window.alert = function (message) {
    if (sessionStorage.getItem('frp.noname.armed') && message === '请稍后再试') {
      sessionStorage.removeItem('frp.noname.join');
      sessionStorage.removeItem('frp.noname.armed');
      clearJoinFromUrl();
      toast('这个房间已经开局，房主没有开「允许观战」，所以进不去。', 5200);
      return undefined;
    }
    return originalAlert.call(window, message);
  };

  /*
   * 无名杀进联机大厅时会顺手读剪贴板里的"邀请链接"；读不到就 `confirm` 问一句。
   * 自动进房是我们替用户点的，不该再弹一个确认框（他刚才已经点了「进入」）。
   * 只在 armed 的那一小段时间里、只对这一句回答"否"。
   */
  const originalConfirm = window.confirm;
  window.confirm = function (message) {
    if (sessionStorage.getItem('frp.noname.armed') && String(message).indexOf('邀请链接') !== -1) {
      return false;
    }
    return originalConfirm.call(window, message);
  };
}

async function boot() {
  // 无名杀的 index 有时会把同一个桥接脚本插两次；重复 boot 会并发两次 game.connect
  if (window.__frpNonameBooted) return;
  window.__frpNonameBooted = true;
  if (!patchSetBackground()) {
    // 无名杀的 polyfill 是它启动后才挂到原型上的；挂上之前每 300ms 重试一次
    const timer = setInterval(() => {
      if (patchSetBackground()) clearInterval(timer);
    }, 300);
    setTimeout(() => clearInterval(timer), 30_000);
  }
  interceptFailedJoin();
  console.info('[平台] 桥接脚本启动');

  try {
    await loadMe();
    console.info('[平台] 已读到平台账号：' + (me && me.name));
  } catch (err) {
    return; // 401 已经跳登录页了
  }

  /*
   * 昵称/头像同步单独跑，**不能挡深链**：无名杀如果上次停在联机模式，
   * 主菜单容器可能根本不建，等它 30 秒会把自动进房一起拖死。
   */
  (async () => {
    const meReady = await waitFor(() => ui.menuContainer, 30_000);
    console.info('[平台] 无名杀菜单就绪：' + Boolean(meReady));
    if (!meReady) return;
    // 菜单建好 = 无名杀已经读完本地配置；这时候写才不会被它启动时的默认值盖掉。
    // 再补两次是防"菜单建好之后还有一段异步配置回填"。
    applyIdentity();
    setTimeout(applyIdentity, 800);
    setTimeout(applyIdentity, 2500);
  })();

  /*
   * 给体检脚本 / 用户排查用的一小块只读状态。
   * ⚠️ 只暴露昵称、头像地址、房号这类公开信息，不碰对局内容。
   */
  window.__frpNonameState = () => ({
    me: me,
    nick: lib.config.connect_nickname,
    avatar: lib.config.connect_avatar,
    room: game.roomId || '',
    observe: Boolean(game.observe),
    online: Boolean(game.online || game.onlinehall),
    iptext: ui.iptext ? String(ui.iptext.textContent || '') : '',
    patched: Boolean(window.HTMLDivElement.prototype.__frpAvatarPatched),
  });

  watchMenu();
  const joinCode = readJoinCode();
  if (joinCode) {
    sessionStorage.setItem('frp.noname.join', joinCode);
    autoJoin(joinCode);
  }
  watchRoomEntered();

  // 状态：3 秒看一次变化，15 秒无条件心跳（服务端 45 秒过期）
  await sendState(true);
  setInterval(() => { sendState(false); }, STATE_POLL_MS);
  setInterval(() => { sendState(true); }, HEARTBEAT_MS);

  // 平台里改了名字/头像：最多一分钟内同步过来
  setInterval(() => { loadMe().catch(() => {}); }, ME_POLL_MS);

  // 页面关掉时尽量告诉平台"我走了"（不保证送达，服务端还有 TTL 兜底）
  window.addEventListener('pagehide', () => {
    try {
      navigator.sendBeacon(STATE_URL, new Blob([JSON.stringify({ room: '' })], { type: 'application/json' }));
    } catch (err) {
      /* 发不出去就等 TTL */
    }
  });

  console.info('[平台] 无名杀桥接已启用：名字/头像/邀请/在线状态');
}

boot();
