/*
 * frp-game 平台桥接层（不属于上游界面代码，补丁清单见 games/mahjong/README.md）。
 *
 * 只做三件事，全部是"平台外壳"的职责：
 *   1. 把当前房间报给平台（好友列表里的「正在玩 莲花广麻 / 进入」）；
 *   2. 房间里的「邀请好友」浮层（读平台好友、发平台邀请）；
 *   3. 好友接受邀请后由平台打开 `/mahjong/?join=房号`，App.vue 负责真的进房。
 *
 * 不碰牌桌、规则、房间布局 —— 上游界面保持原样。
 */

export interface MahjongBridgeRoom {
  roomId: string;
  started: boolean;
  count: number;
}

export interface MahjongBridgeOptions {
  getRoom: () => MahjongBridgeRoom;
  /** 当前联机昵称（只用于邀请弹窗里显示"你是 xxx"，可省略）。 */
  getNickname?: () => string;
}

type Friend = {
  id: string;
  name: string;
  avatar?: string;
  online?: boolean;
  playing?: { game?: string; code?: string; started?: boolean } | null;
};

const PRESENCE_INTERVAL_MS = 15_000;
const TICK_MS = 1000;

let started = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let options: MahjongBridgeOptions | null = null;
let lastBody = '';
let lastPostedAt = 0;

function snapshot(): Record<string, unknown> {
  if (!options) return { room: '', game: 'mahjong' };
  const room = options.getRoom();
  if (!room.roomId) return { room: '', game: 'mahjong' };
  return {
    room: room.roomId,
    game: 'mahjong',
    started: Boolean(room.started),
    count: Number(room.count) || 1,
    joinable: !room.started,
  };
}

async function postState(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/mahjong/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      keepalive: true,
    });
  } catch {
    /* 页面正在卸载/断网：下一拍会重试 */
  }
}

function tick(): void {
  const body = snapshot();
  const text = JSON.stringify(body);
  const now = Date.now();
  if (text === lastBody && now - lastPostedAt < PRESENCE_INTERVAL_MS) return;
  lastBody = text;
  lastPostedAt = now;
  void postState(body);
  syncInviteButton();
}

/* -------------------------------------------------------------------------- */
/* 邀请好友浮层（平台外壳，样式独立，不依赖上游组件的 class）                    */
/* -------------------------------------------------------------------------- */

const OVERLAY_ID = 'frp-mahjong-invite-root';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) node.setAttribute('style', style);
  return node;
}

function statusText(friend: Friend): string {
  if (!friend.online) return '离线';
  const playing = friend.playing;
  if (playing?.game === 'mahjong' && playing.code) {
    return `正在玩莲花广麻（${playing.code}）`;
  }
  if (playing?.code) return `正在玩其它游戏（${playing.code}）`;
  return '在线';
}

function inviteButton(): HTMLButtonElement {
  let root = document.getElementById(OVERLAY_ID);
  if (!root) {
    root = el('div');
    root.id = OVERLAY_ID;
    root.setAttribute('style', [
      'position:fixed', 'right:16px', 'bottom:24px', 'z-index:2147483000',
      'display:flex', 'flex-direction:column', 'align-items:flex-end', 'gap:8px',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
    ].join(';'));
    document.body.appendChild(root);
  }
  let button = root.querySelector('button[data-frp-invite]') as HTMLButtonElement | null;
  if (!button) {
    button = el('button');
    button.type = 'button';
    button.dataset.frpInvite = '1';
    button.textContent = '邀请好友';
    button.setAttribute('style', [
      'border:0', 'border-radius:999px', 'padding:12px 18px', 'font-size:15px',
      'font-weight:600', 'color:#10231a', 'background:#f3c969', 'cursor:pointer',
      'box-shadow:0 6px 20px rgba(0,0,0,.35)',
    ].join(';'));
    button.addEventListener('click', () => { void openInviteDialog(); });
    root.appendChild(button);
  }
  return button;
}

/** 只有"在房间里、还没开局"才显示邀请按钮；别的时候不打扰玩家。 */
function syncInviteButton(): void {
  const room = options ? options.getRoom() : { roomId: '', started: false, count: 0 };
  const show = Boolean(room.roomId) && !room.started;
  const root = document.getElementById(OVERLAY_ID);
  if (!show) {
    root?.remove();
    return;
  }
  inviteButton();
}

function closeInviteDialog(): void {
  document.getElementById('frp-mahjong-invite-dialog')?.remove();
}

async function openInviteDialog(): Promise<void> {
  const room = options ? options.getRoom() : { roomId: '', started: false, count: 0 };
  if (!room.roomId || room.started) return;
  closeInviteDialog();

  const wrap = el('div');
  wrap.id = 'frp-mahjong-invite-dialog';
  wrap.setAttribute('style', [
    'position:fixed', 'inset:0', 'z-index:2147483001', 'display:flex',
    'align-items:center', 'justify-content:center', 'background:rgba(0,0,0,.55)',
    'padding:16px', 'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
  ].join(';'));

  const card = el('div');
  card.setAttribute('style', [
    'width:min(420px,100%)', 'max-height:min(70vh,560px)', 'display:flex',
    'flex-direction:column', 'background:#16241f', 'color:#eef5f0',
    'border:1px solid #3a5a4c', 'border-radius:16px', 'padding:18px',
    'box-shadow:0 20px 60px rgba(0,0,0,.5)',
  ].join(';'));

  const title = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px');
  const heading = el('b', 'font-size:17px');
  heading.textContent = `邀请好友（房间 ${room.roomId}）`;
  const closeBtn = el('button', 'border:0;background:transparent;color:#9fb8ab;font-size:20px;cursor:pointer');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeInviteDialog);
  title.append(heading, closeBtn);

  const hint = el('p', 'margin:0 0 10px;color:#9fb8ab;font-size:13px;line-height:1.5');
  hint.textContent = '勾选在线的平台好友，他们那边会弹出邀请卡片（点「进入」直接进这个房）。';

  const list = el('div', 'flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:80px');
  list.textContent = '正在加载好友…';

  const footer = el('div', 'display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:12px');
  const status = el('span', 'color:#9fb8ab;font-size:13px;flex:1');
  const send = el('button', [
    'border:0', 'border-radius:10px', 'padding:10px 16px', 'font-size:15px',
    'font-weight:600', 'color:#10231a', 'background:#f3c969', 'cursor:pointer',
  ].join(';'));
  send.type = 'button';
  send.textContent = '发送邀请';
  send.disabled = true;
  footer.append(status, send);

  card.append(title, hint, list, footer);
  wrap.append(card);
  wrap.addEventListener('click', (event) => {
    if (event.target === wrap) closeInviteDialog();
  });
  document.body.appendChild(wrap);

  const selected = new Set<string>();

  try {
    const res = await fetch('/api/mahjong/friends', { credentials: 'same-origin' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.message || '好友列表加载失败');
    const friends: Friend[] = Array.isArray(json?.friends) ? json.friends : [];
    list.textContent = '';
    if (!friends.length) {
      list.textContent = '还没有好友：先在平台首页加好友，再邀请他。';
      return;
    }
    for (const friend of friends) {
      const row = el('label', [
        'display:flex', 'align-items:center', 'gap:10px', 'padding:8px 10px',
        'border-radius:10px', 'background:#1e332b', 'cursor:pointer',
      ].join(';'));
      const box = el('input');
      box.type = 'checkbox';
      box.disabled = !friend.online;
      box.addEventListener('change', () => {
        if (box.checked) selected.add(friend.id);
        else selected.delete(friend.id);
        send.disabled = selected.size === 0;
        status.textContent = selected.size ? `已选 ${selected.size} 人` : '';
      });
      const name = el('span', 'font-size:14px');
      name.textContent = friend.name || friend.id;
      const state = el('span', 'margin-left:auto;color:#9fb8ab;font-size:12px');
      state.textContent = statusText(friend);
      row.append(box, name, state);
      list.appendChild(row);
    }
  } catch (error) {
    list.textContent = '好友列表加载失败，稍后再试。';
    status.textContent = String((error as Error)?.message || '');
  }

  send.addEventListener('click', async () => {
    if (selected.size === 0) return;
    send.disabled = true;
    send.textContent = '发送中…';
    status.textContent = '';
    try {
      const res = await fetch('/api/mahjong/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ room: room.roomId, to: [...selected] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) throw new Error(json?.message || '邀请发送失败');
      const delivered = Array.isArray(json.delivered) ? json.delivered.length : 0;
      status.textContent = delivered > 0
        ? `已邀请 ${delivered} 位好友（在平台页面上能看到邀请卡片）`
        : '一个都没发出去：好友可能不在平台页面上';
      send.textContent = '再次发送';
      send.disabled = false;
      window.setTimeout(closeInviteDialog, 1600);
    } catch (error) {
      status.textContent = String((error as Error)?.message || '邀请发送失败');
      send.textContent = '发送邀请';
      send.disabled = false;
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 启动                                                                        */
/* -------------------------------------------------------------------------- */

export function startMahjongBridge(next: MahjongBridgeOptions): void {
  if (started) return;
  if (typeof document === 'undefined') return;
  options = next;
  started = true;
  tick();
  tickTimer = setInterval(tick, TICK_MS);
  window.addEventListener('pagehide', () => {
    try {
      navigator.sendBeacon?.('/api/mahjong/state', JSON.stringify({ room: '', game: 'mahjong' }));
    } catch {
      /* 忽略 */
    }
  });
}

export function stopMahjongBridge(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  document.getElementById(OVERLAY_ID)?.remove();
  closeInviteDialog();
  started = false;
}