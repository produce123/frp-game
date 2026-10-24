/*
 * 狼人杀页面与平台之间的唯一通道。
 *
 * 两件事：
 *   1. `api()` —— 调 `/api/werewolf/*`。身份只靠平台会话 cookie（`sid`），
 *      所以这里**没有任何 token / 昵称参数**，也绝不把玩家自己填的名字发给服务器。
 *   2. `connectRealtime()` —— 连平台的 `/ws`，只认两种消息：
 *      `ready`（连上了，带回我是谁）和 `werewolf.event`（"房间变了，去拉状态"）。
 *
 * 底牌永远不在这条连接里：收到 `werewolf.event` 之后页面会重新 `GET /game/status`，
 * 服务器按人裁剪好再返回。
 */

export interface ServerPlayer {
  playerId: string;
  seat: number;
  displayName: string;
  avatar?: string;
  alive: boolean;
  isHost?: boolean;
  isHuman: boolean;
  role?: string;
  alignment?: "wolf" | "village";
}

export interface ServerMessage {
  id: string;
  playerId: string;
  playerName: string;
  content: string;
  timestamp: number;
  day?: number;
  phase?: string;
  isSystem?: boolean;
  isLastWords?: boolean;
}

export interface ServerView {
  code: string;
  phase: string;
  day: number;
  startedAt: number;
  deadline: number;
  phaseStartedAt: number;
  duration: number;
  players: ServerPlayer[];
  messages: ServerMessage[];
  currentSpeakerSeat: number | null;
  speechOrder: number[];
  badge: { holderSeat: number | null; candidates: number[] };
  aliveCount: number;
  sheriffEnabled?: boolean;
  goodSkillsDisabled?: boolean;
  self: {
    id: string;
    seat: number;
    name: string;
    avatar: string;
    role: string;
    alignment: "wolf" | "village";
    alive: boolean;
    isHost: boolean;
    vote: number | null;
    badgeVote: number | null;
    signup: boolean | null;
  };
  winner: "wolf" | "village" | null;
  endedAt: number;
  recordId: number | null;
  votedSeats: number[];
  badgeVotedSeats: number[];
  signupDecided: number[];
  signupCandidates: number[];
  roleReveal: { winner: string; players: Array<{ seat: number; name: string; role: string; alive: boolean }> } | null;
  can: Record<string, boolean>;
  private: {
    role: string;
    roleName: string;
    alignment: "wolf" | "village";
    wolfTeammates: Array<{ seat: number; name: string; alive: boolean }>;
    wolfVotes?: Record<string, number>;
    seerHistory: Array<{ targetSeat: number; isWolf: boolean; day: number }>;
    witch: { healUsed: boolean; poisonUsed: boolean; victimSeat: number | null; canHeal?: boolean; canPoison?: boolean } | null;
    guard: { lastTarget: number | null } | null;
    hunterCanShoot: boolean;
    idiotRevealed: boolean;
    wwkUsed: boolean;
    elderLives?: number;
    knightUsed?: boolean;
    wolfKingCanShoot?: boolean;
    skillsBlocked?: boolean;
    evilReflectUsed?: boolean;
    grave?: {
      disabled: boolean;
      day: number | null;
      seat: number | null;
      name: string | null;
      alignment: "wolf" | "village" | null;
    } | null;
    wolfBeauty?: { lastTarget: number | null; charmedSeat: number | null } | null;
  };
}

export interface LobbyPlayer {
  id: string;
  seat: number;
  name: string;
  avatar: string;
  isHost: boolean;
}

export interface Lobby {
  code: string;
  seats: number;
  roles?: Record<string, number>;
  sheriff?: boolean;
  hostId: string;
  started: boolean;
  phase: string;
  password: boolean;
  me: { id: string; seat: number; isHost: boolean };
  players: LobbyPlayer[];
}

export interface RoomPresence {
  game: "werewolf";
  code: string;
  phase: "waiting" | "playing" | "over";
  joinable: boolean;
  started: boolean;
  count: number;
  seats: number;
}

export interface MeInfo {
  id: string;
  name: string;
  avatar?: string;
  avatar_at?: number;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const PREFIX = "/api/werewolf";

/** 调一条狼人杀接口。失败一律 throw（界面用 toast 显示 message）。 */
export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(PREFIX + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 401) throw new ApiError("还没登录", 401);
  let data: { ok?: boolean; message?: string; data?: T } = {};
  try {
    data = await res.json();
  } catch {
    throw new ApiError("服务器返回的不是 JSON", res.status);
  }
  if (!data.ok) throw new ApiError(data.message || "请求失败", res.status);
  return (data.data ?? {}) as T;
}

/** 我自己的账号（昵称/头像来自平台，页面上没有输入框）。 */
export async function fetchMe(): Promise<{ me: MeInfo; room: RoomPresence | null }> {
  return api<{ me: MeInfo; room: RoomPresence | null }>("/me");
}

export async function fetchStatus(): Promise<{ room: RoomPresence | null; view: ServerView | null }> {
  return api<{ room: RoomPresence | null; view: ServerView | null }>("/game/status");
}

export async function fetchLobby(): Promise<{ lobby: Lobby; me: MeInfo }> {
  return api<{ lobby: Lobby; me: MeInfo }>("/room/init");
}

export interface IncomingInvite {
  from: { id: string; name: string; avatar?: string };
  game: string;
  code: string;
}

/**
 * 连平台 WebSocket。
 *
 * 只做"信号"：`werewolf.event` 到了就回调一次，页面自己去拉状态；
 * `invite` 是好友发来的邀请（房号在 code 里）。
 * 断线自动重连（1s、2s、5s 封顶 5s），心跳 25s/次 —— 和平台外壳同一套数字。
 *
 * 返回值里带 `send`：邀请好友就走这条连接（平台只转发，不替我们入座）。
 */
export function connectRealtime(options: {
  onReady?: (me: MeInfo) => void;
  onRoomEvent?: (code: string) => void;
  onInvite?: (invite: IncomingInvite) => void;
  onStatus?: (connected: boolean) => void;
}): { close: () => void; send: (msg: Record<string, unknown>) => boolean } {
  if (typeof window === "undefined") return { close: () => {}, send: () => false };
  let closed = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let attempts = 0;

  const clearPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(5000, 1000 * Math.max(1, attempts));
    attempts += 1;
    retryTimer = setTimeout(open, delay);
  };

  const open = () => {
    if (closed) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      attempts = 0;
      options.onStatus?.(true);
      clearPing();
      pingTimer = setInterval(() => {
        try {
          ws.send(JSON.stringify({ t: "ping", ts: Date.now() }));
        } catch {
          /* 下一条消息会触发重连 */
        }
      }, 25_000);
    };
    ws.onmessage = (event) => {
      let msg: {
        t?: string;
        me?: MeInfo;
        code?: string;
        from?: IncomingInvite["from"];
        game?: string;
      };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.t === "ready" && msg.me) options.onReady?.(msg.me);
      if (msg.t === "werewolf.event" && msg.code) options.onRoomEvent?.(msg.code);
      if (msg.t === "invite" && msg.code && msg.from) {
        options.onInvite?.({
          from: msg.from as IncomingInvite["from"],
          game: String(msg.game || ""),
          code: String(msg.code),
        });
      }
    };
    ws.onclose = () => {
      clearPing();
      options.onStatus?.(false);
      socket = null;
      scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    };
  };

  open();

  return {
    close: () => {
      closed = true;
      clearPing();
      if (retryTimer) clearTimeout(retryTimer);
      if (socket) {
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* 忽略 */
        }
      }
    },
    send: (msg) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      try {
        socket.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    },
  };
}