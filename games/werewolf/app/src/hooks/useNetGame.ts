"use client";

/*
 * 狼人杀页面的数据源（唯一）：
 *   · 所有游戏状态都来自 `/api/werewolf/game/status`（服务器按人裁剪过的视图）；
 *   · 所有操作都走 `/api/werewolf/game/act`；
 *   · 平台 WS 只负责"叮咚"——收到 `werewolf.event` 就重新拉一次状态。
 *
 * 这里**不存任何身份信息**（也不写 localStorage）：
 * 刷新页面 = 从服务器重新拉视图，换一台电脑登录同一账号也是同一个座位。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, GameState, Phase, Player, Role } from "@/types/game";
import {
  api,
  connectRealtime,
  fetchLobby,
  fetchMe,
  fetchStatus,
  type IncomingInvite,
  type Lobby,
  type MeInfo,
  type RoomPresence,
  type ServerView,
} from "@/lib/net/platform";

export interface NetGame {
  me: MeInfo | null;
  room: RoomPresence | null;
  view: ServerView | null;
  lobby: Lobby | null;
  connected: boolean;
  busy: boolean;
  error: string;
  gameState: GameState | null;
  humanPlayer: Player | null;
  isNight: boolean;
  refresh: () => Promise<void>;
  createRoom: (seats: number, password?: string, roles?: Record<string, number>, sheriff?: boolean, winMode?: "side" | "wipe") => Promise<void>;
  joinRoom: (code: string, password?: string) => Promise<void>;
  leaveRoom: () => Promise<void>;
  startGame: () => Promise<void>;
  act: (action: Record<string, unknown>) => Promise<void>;
  invite: (ids: string[]) => boolean;
  incomingInvite: IncomingInvite | null;
  dismissInvite: () => void;
  clearError: () => void;
  backToLobby: () => Promise<void>;
  /** 结算页「再来一局」：房主把房间退回等候区，座位都不动 */
  restartGame: () => Promise<void>;
}

/** 服务器视图 → 上游 UI 组件认识的 `GameState`（只填真实的字段，其余给空默认值）。 */
export function viewToGameState(view: ServerView, meId: string): GameState {
  const players: Player[] = view.players.map((p) => ({
    playerId: p.playerId,
    seat: p.seat,
    displayName: p.displayName,
    avatarSeed: p.avatar || "",
    alive: p.alive,
    role: (p.role || "Villager") as Role,
    alignment: p.alignment || "village",
    // 上游语义：isHuman = "这张卡就是我自己"。
    // 联机局里每个座位都是真人，写死 true 会让 8 张卡都挂上「你」。
    isHuman: p.playerId === meId,
  }));

  const messages: ChatMessage[] = view.messages.map((m) => ({
    id: m.id,
    playerId: m.playerId,
    playerName: m.playerName,
    content: m.content,
    timestamp: m.timestamp,
    day: m.day,
    phase: m.phase as Phase | undefined,
    isSystem: m.isSystem,
    isLastWords: m.isLastWords,
  }));

  // 投票进度条只认"谁投过了"，不认投给谁（结果在 [VOTE_RESULT] 卡片里公布）
  const votes: Record<string, number> = {};
  for (const seat of view.votedSeats) {
    const p = view.players.find((x) => x.seat === seat);
    if (p) votes[p.playerId] = view.self.vote !== null && p.playerId === meId ? view.self.vote : -1;
  }
  const badgeVotes: Record<string, number> = {};
  for (const seat of view.badgeVotedSeats) {
    const p = view.players.find((x) => x.seat === seat);
    if (p) badgeVotes[p.playerId] = view.self.badgeVote !== null && p.playerId === meId ? view.self.badgeVote : -1;
  }
  // 报名状态：候选人 = true，已经表过态的其他人 = false
  const signup: Record<string, boolean> = {};
  for (const seat of view.signupDecided) {
    const p = view.players.find((x) => x.seat === seat);
    if (p) signup[p.playerId] = view.signupCandidates.includes(seat);
  }
  if (view.self.signup !== null) signup[meId] = view.self.signup;

  const seerHistory = (view.private.seerHistory || []).map((h) => ({
    targetSeat: h.targetSeat,
    isWolf: h.isWolf,
    day: h.day,
  }));

  return {
    gameId: view.code,
    phase: view.phase as Phase,
    day: view.day,
    startTime: view.startedAt,
    difficulty: "normal",
    players,
    messages,
    currentSpeakerSeat: view.currentSpeakerSeat,
    daySpeechStartSeat: null,
    badge: {
      holderSeat: view.badge.holderSeat,
      candidates: view.badge.candidates,
      signup,
      votes: badgeVotes,
      allVotes: {},
      history: {},
      revoteCount: 0,
    },
    votes,
    voteHistory: {},
    nightHistory: {},
    dailySummaries: {},
    dailySummaryFacts: {},
    nightActions: {
      guardTarget: undefined,
      lastGuardTarget: view.private.guard?.lastTarget ?? undefined,
      wolfVotes: view.private.wolfVotes || {},
      wolfTarget: view.private.witch?.victimSeat ?? undefined,
      seerHistory,
    },
    roleAbilities: {
      witchHealUsed: view.private.witch?.healUsed ?? false,
      witchPoisonUsed: view.private.witch?.poisonUsed ?? false,
      witchCanHeal: view.private.witch?.canHeal ?? false,
      witchCanPoison: view.private.witch?.canPoison ?? false,
      hunterCanShoot: view.private.hunterCanShoot,
      idiotRevealed: view.private.idiotRevealed,
      whiteWolfKingBoomUsed: view.private.wwkUsed,
      elderLives: view.private.elderLives ?? 2,
      knightUsed: view.private.knightUsed ?? false,
      wolfKingCanShoot: view.private.wolfKingCanShoot ?? false,
      skillsBlocked: view.private.skillsBlocked ?? false,
      grave: view.private.grave ?? null,
      wolfBeauty: view.private.wolfBeauty ?? null,
    },
    winner: view.winner,
  } as GameState;
}

export function useNetGame(): NetGame {
  const [me, setMe] = useState<MeInfo | null>(null);
  const [room, setRoom] = useState<RoomPresence | null>(null);
  const [view, setView] = useState<ServerView | null>(null);
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [incomingInvite, setIncomingInvite] = useState<IncomingInvite | null>(null);

  const sendRef = useRef<((msg: Record<string, unknown>) => boolean) | null>(null);

  const inFlight = useRef(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const status = await fetchStatus();
      setRoom(status.room);
      setView(status.view);
      if (status.room && status.room.phase === "waiting") {
        try {
          const data = await fetchLobby();
          setLobby(data.lobby);
          setMe((prev) => prev ?? data.me);
        } catch {
          setLobby(null);
        }
      } else {
        setLobby(null);
      }
    } catch (err) {
      if ((err as Error).message === "还没登录") {
        window.location.href = "/";
        return;
      }
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
      if (pending.current) {
        pending.current = false;
        void load();
      }
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await fetchMe();
        setMe(data.me);
        await load();
      } catch (err) {
        if ((err as Error).message === "还没登录") {
          window.location.href = "/";
          return;
        }
        setError((err as Error).message);
      }
    })();
    const realtime = connectRealtime({
      onReady: (info) => setMe((prev) => prev ?? info),
      onRoomEvent: () => {
        void load();
      },
      onInvite: (invite) => {
        // 只处理狼人杀的邀请；平台房间的邀请与自己无关
        if (invite.game !== "werewolf") return;
        setIncomingInvite(invite);
      },
      onStatus: setConnected,
    });
    sendRef.current = realtime.send;
    // 兜底：WS 万一漏了事件（比如手机息屏回来），每 5 秒补一次状态
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5000);
    return () => {
      realtime.close();
      sendRef.current = null;
      clearInterval(timer);
    };
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await fn();
        await load();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const createRoom = useCallback(
    (
      seats: number,
      password?: string,
      roles?: Record<string, number>,
      sheriff?: boolean,
      winMode?: "side" | "wipe",
    ) =>
      run(async () => {
        await api("/room/create", {
          seats,
          password: password || "",
          roles,
          sheriff: sheriff !== false,
          winMode: winMode === "wipe" ? "wipe" : "side",
        });
      }),
    [run],
  );

  const joinRoom = useCallback(
    (code: string, password?: string) =>
      run(async () => {
        await api("/room/join", { code, password: password || "" });
      }),
    [run],
  );

  const leaveRoom = useCallback(
    () =>
      run(async () => {
        await api("/room/leave", {});
      }),
    [run],
  );

  const startGame = useCallback(
    () =>
      run(async () => {
        await api("/game/begin", {});
      }),
    [run],
  );

  const act = useCallback(
    (action: Record<string, unknown>) =>
      run(async () => {
        const data = await api<{ view: ServerView | null }>("/game/act", action);
        if (data && "view" in data) setView(data.view ?? null);
      }),
    [run],
  );

  const backToLobby = useCallback(async () => {
    // 必须先退出房间：只清本地 state 的话，下一次拉状态又会被拉回这张结算画面。
    try {
      await api("/room/leave", {});
    } catch {
      /* 房间可能已经被回收了，照常回大厅 */
    }
    setView(null);
    setRoom(null);
    setLobby(null);
    await load();
  }, [load]);

  const restartGame = useCallback(async () => {
    await run(async () => {
      await api("/room/restart", {});
      await load();
    });
  }, [load, run]);

  const invite = useCallback(
    (ids: string[]) => {
      if (!ids.length || !room?.code) return false;
      return sendRef.current?.({ t: "invite.send", to: ids, code: room.code }) ?? false;
    },
    [room?.code],
  );

  const gameState = useMemo(
    () => (view && view.phase !== "waiting" && Array.isArray(view.players) ? viewToGameState(view, me?.id || "") : null),
    [view, me?.id],
  );
  const humanPlayer = useMemo(
    () => gameState?.players.find((p) => p.playerId === me?.id) ?? null,
    [gameState, me?.id],
  );
  const isNight = Boolean(view && view.phase.startsWith("NIGHT_"));

  return {
    me,
    room,
    view,
    lobby,
    connected,
    busy,
    error,
    gameState,
    humanPlayer,
    isNight,
    refresh: load,
    createRoom,
    joinRoom,
    leaveRoom,
    startGame,
    act,
    invite,
    incomingInvite,
    dismissInvite: () => setIncomingInvite(null),
    clearError: () => setError(""),
    backToLobby,
    restartGame,
  };
}