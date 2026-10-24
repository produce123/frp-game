"use client";

/*
 * 狼人杀的牌桌页。
 *
 * 身份、阶段、倒计时、谁能看见什么，全部由服务器决定（`useNetGame` 只负责搬运）。
 * 这个文件只做三件事：
 *   1. 把服务器视图摆成上游那套牌桌（左右玩家卡 + 中间对话框）；
 *   2. 把点击翻译成 `/api/werewolf/game/act`；
 *   3. 没有房间时显示大厅（建/进/邀请）。
 *
 * 与上游最大的区别：**没有 AI**。没有模型选择、没有旁白、没有「AI 助我」、
 * 没有单人模式，也不存在"等 AI 思考"的转圈 —— 所有人都是真人，轮到你时就是你说话。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import { GearSix, SignOut, Timer, UsersThree } from "@phosphor-icons/react";

import { GameBackground } from "@/components/game/GameBackground";
import { PlayerCardCompact } from "@/components/game/PlayerCardCompact";
import { DialogArea } from "@/components/game/DialogArea";
import { RoleRevealOverlay } from "@/components/game/RoleRevealOverlay";
import { Notebook } from "@/components/game/Notebook";
import { Lobby } from "@/components/game/Lobby";
import { useNetGame } from "@/hooks/useNetGame";
import { isWolfRole, type Player } from "@/types/game";

const PHASE_LABEL: Record<string, string> = {
  NIGHT_START: "天黑请闭眼",
  NIGHT_GUARD_ACTION: "守卫行动",
  NIGHT_WOLF_ACTION: "狼人行动",
  NIGHT_WOLF_BEAUTY_ACTION: "狼美人魅惑",
  NIGHT_WITCH_ACTION: "女巫行动",
  NIGHT_SEER_ACTION: "预言家查验",
  NIGHT_RESOLVE: "夜间结算",
  DAY_START: "天亮了",
  DAY_BADGE_SIGNUP: "警长竞选 · 报名",
  DAY_BADGE_SPEECH: "警长竞选 · 发言",
  DAY_BADGE_ELECTION: "警长竞选 · 投票",
  DAY_PK_SPEECH: "PK 发言",
  DAY_SPEECH: "白天讨论",
  DAY_LAST_WORDS: "遗言",
  DAY_VOTE: "放逐投票",
  DAY_RESOLVE: "投票结算",
  BADGE_TRANSFER: "警徽移交",
  HUNTER_SHOOT: "开枪",
  WHITE_WOLF_KING_BOOM: "自爆",
  GAME_END: "本局结束",
};

const ROLE_LABEL: Record<string, string> = {
  Werewolf: "狼人",
  WhiteWolfKing: "白狼王",
  EvilKnight: "恶夜骑士",
  WolfKing: "狼王",
  WolfBeauty: "狼美人",
  Seer: "预言家",
  Witch: "女巫",
  Hunter: "猎人",
  Guard: "守卫",
  Idiot: "白痴",
  Knight: "骑士",
  Elder: "长老",
  Gravekeeper: "守墓人",
  Villager: "平民",
};

function roleLabel(role?: string) {
  return (role && ROLE_LABEL[role]) || role || "";
}

export default function WerewolfPage() {
  const net = useNetGame();
  const { view, gameState, humanPlayer } = net;
  const isNight = Boolean(view && view.phase.startsWith("NIGHT_"));

  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [inputText, setInputText] = useState("");
  const [isEventLogOpen, setIsEventLogOpen] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const revealedRef = useRef<string>("");

  /* ------------------------------ 错误提示 ------------------------------ */

  useEffect(() => {
    if (!net.error) return;
    toast.error(net.error);
    net.clearError();
  }, [net.error, net]);

  /* ------------------------------ 倒计时 ------------------------------ */

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [view?.deadline]);

  const remainMs = view?.deadline ? Math.max(0, view.deadline - now) : 0;
  const remainText = useMemo(() => {
    if (!view?.deadline) return "";
    const seconds = Math.ceil(remainMs / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, [remainMs, view?.deadline]);

  /* ------------------------------ 阶段切换：清空选择 ------------------------------ */

  useEffect(() => {
    setSelectedSeat(null);
    setInputText("");
  }, [view?.phase, view?.day]);

  /* ------------------------------ 首次发牌：看一眼自己的身份 ------------------------------ */

  useEffect(() => {
    if (!view || !net.room || net.room.phase !== "playing") return;
    const key = `${view.code}:${view.startedAt}`;
    if (revealedRef.current === key) return;
    revealedRef.current = key;
    try {
      if (sessionStorage.getItem(`ww.reveal.${key}`)) return;
      sessionStorage.setItem(`ww.reveal.${key}`, "1");
    } catch {
      /* 无痕模式也能玩 */
    }
    setRevealOpen(true);
  }, [view, net.room]);

  /* ------------------------------ 能点谁 ------------------------------ */

  const wolfSeats = useMemo(
    () => new Set((view?.private?.wolfTeammates || []).map((p) => p.seat)),
    [view?.private?.wolfTeammates],
  );

  const seerResults = useMemo(() => {
    const map = new Map<number, "wolf" | "good">();
    if (humanPlayer?.role !== "Seer") return map;
    for (const item of gameState?.nightActions.seerHistory || []) {
      map.set(item.targetSeat, item.isWolf ? "wolf" : "good");
    }
    return map;
  }, [gameState?.nightActions.seerHistory, humanPlayer?.role]);

  const canSelectSeat = useCallback(
    (player: Player): boolean => {
      if (!view || !humanPlayer || !player.alive) return false;
      const can = view.can;
      const phase = view.phase;
      switch (phase) {
        case "NIGHT_GUARD_ACTION":
          return Boolean(can.guard) && view.private.guard?.lastTarget !== player.seat;
        case "NIGHT_WOLF_ACTION":
          return Boolean(can.wolf) && (player.seat !== humanPlayer.seat || humanPlayer.role === "WolfKing");
        case "NIGHT_WOLF_BEAUTY_ACTION":
          return Boolean(can.wolfBeauty) && player.seat !== humanPlayer.seat
            && player.seat !== view.private.wolfBeauty?.lastTarget;
        case "NIGHT_WITCH_ACTION":
          return Boolean(can.witch) && view.private.witch?.canPoison !== false && player.seat !== humanPlayer.seat;
        case "NIGHT_SEER_ACTION":
          return Boolean(can.seer) && player.seat !== humanPlayer.seat;
        case "HUNTER_SHOOT":
          return Boolean(can.hunter) && player.seat !== humanPlayer.seat;
        case "DAY_VOTE":
          return Boolean(can.vote) && player.seat !== humanPlayer.seat;
        case "DAY_BADGE_ELECTION":
          return Boolean(can.badgeVote) && view.badge.candidates.includes(player.seat);
        case "BADGE_TRANSFER":
          return Boolean(can.transfer) && player.seat !== humanPlayer.seat;
        case "DAY_BADGE_SPEECH":
        case "DAY_SPEECH":
        case "DAY_PK_SPEECH":
          return Boolean(can.wwkBoom || can.knight) && player.seat !== humanPlayer.seat;
        default:
          return false;
      }
    },
    [view, humanPlayer, wolfSeats],
  );

  const handleSeatClick = useCallback(
    (player: Player) => {
      if (!canSelectSeat(player)) return;
      setSelectedSeat((prev) => (prev === player.seat ? null : player.seat));
    },
    [canSelectSeat],
  );

  const submit = useCallback(
    async (action: Record<string, unknown>) => {
      setSelectedSeat(null);
      await net.act(action);
    },
    [net],
  );

  const confirmSelectedSeat = useCallback(async () => {
    if (!view) return;
    const phase = view.phase;

    // 空选：撕警徽 / 猎人不开枪
    if (selectedSeat === null) {
      if (phase === "BADGE_TRANSFER" && view.can.transfer) await submit({ type: "transfer", seat: null });
      else if (phase === "HUNTER_SHOOT" && view.can.hunter) await submit({ type: "hunter", seat: null });
      return;
    }

    if (phase === "DAY_VOTE") await submit({ type: "vote", seat: selectedSeat });
    else if (phase === "DAY_BADGE_ELECTION") await submit({ type: "badgeVote", seat: selectedSeat });
    else if (phase === "BADGE_TRANSFER") await submit({ type: "transfer", seat: selectedSeat });
    else if (phase === "NIGHT_GUARD_ACTION") await submit({ type: "guard", seat: selectedSeat });
    else if (phase === "NIGHT_WOLF_ACTION") await submit({ type: "wolf", seat: selectedSeat });
    else if (phase === "NIGHT_WOLF_BEAUTY_ACTION") await submit({ type: "charm", seat: selectedSeat });
    else if (phase === "NIGHT_SEER_ACTION") await submit({ type: "seer", seat: selectedSeat });
    else if (phase === "HUNTER_SHOOT") await submit({ type: "hunter", seat: selectedSeat });
    else if (phase === "DAY_SPEECH" || phase === "DAY_PK_SPEECH") {
      if (view.can.knight) await submit({ type: "knight", seat: selectedSeat });
    }
    // 女巫的毒药由 DialogArea 的按钮确认（onNightAction）
  }, [view, selectedSeat, submit]);

  const handleNightAction = useCallback(
    async (seat: number, actionType?: string) => {
      if (!view) return;
      if (actionType === "save" || actionType === "poison" || actionType === "pass") {
        await submit({
          type: "witch",
          action: actionType,
          ...(actionType === "poison" ? { seat } : {}),
        });
        return;
      }
      if (view.phase === "NIGHT_GUARD_ACTION") await submit({ type: "guard", seat });
      else if (view.phase === "NIGHT_WOLF_ACTION") await submit({ type: "wolf", seat });
      else if (view.phase === "NIGHT_SEER_ACTION") await submit({ type: "seer", seat });
      else if (view.phase === "HUNTER_SHOOT") await submit({ type: "hunter", seat });
    },
    [view, submit],
  );

  const handleSpeak = useCallback(async () => {
    const text = inputText.trim();
    if (!text) return;
    await net.act({ type: "speech", text });
    setInputText("");
  }, [inputText, net]);

  const handleFinishSpeaking = useCallback(async () => {
    await net.act({ type: "endSpeech" });
  }, [net]);

  const handleBadgeSignup = useCallback(
    async (wants: boolean) => {
      await net.act({ type: "signup", wants });
    },
    [net],
  );

  const handleWhiteWolfKingBoom = useCallback(async () => {
    if (selectedSeat === null) {
      toast.error("先点一个人，再自爆带走他");
      return;
    }
    await net.act({ type: "wwkBoom", seat: selectedSeat });
  }, [net, selectedSeat]);

  const handleKnightDuel = useCallback(async () => {
    if (selectedSeat === null) {
      toast.error("先点一个人，再翻牌决斗");
      return;
    }
    await net.act({ type: "knight", seat: selectedSeat });
  }, [net, selectedSeat]);

  const handleWolfKingSelfDestruct = useCallback(async () => {
    if (!window.confirm("确定要自爆吗？自爆会立刻结束白天并进入黑夜，而且不能开枪。")) return;
    await net.act({ type: "wolfSelfDestruct" });
  }, [net]);

  /* ------------------------------ 不玩的时候 ------------------------------ */

  if (!net.room || net.room.phase === "waiting" || !gameState || !view) {
    return (
      <div className="min-h-[100dvh] w-full">
        <GameBackground isNight={false} />
        <div className="relative z-10 min-h-[100dvh]">
          <Lobby net={net} />
        </div>
      </div>
    );
  }

  const humanSeat = humanPlayer?.seat ?? -1;
  const sorted = [...gameState.players].sort((a, b) => a.seat - b.seat);
  const half = Math.ceil(sorted.length / 2);
  const leftPlayers = sorted.slice(0, half);
  const rightPlayers = sorted.slice(half);

  const phaseLabel = PHASE_LABEL[view.phase] || view.phase;
  const waitingForMe = Object.values(view.can).some(Boolean);

  const renderCard = (player: Player, index: number, variant?: "mobile") => (
    <PlayerCardCompact
      key={`${variant || "desk"}-${player.playerId}`}
      player={player}
      isSpeaking={view.currentSpeakerSeat === player.seat}
      canClick={canSelectSeat(player)}
      isSelected={selectedSeat === player.seat}
      onClick={() => handleSeatClick(player)}
      animationDelay={index * 0.03}
      isNight={isNight}
      humanPlayer={humanPlayer}
      seerCheckResult={seerResults.get(player.seat) ?? null}
      showWolfBadge={Boolean(humanPlayer && isWolfRole(humanPlayer.role) && wolfSeats.has(player.seat))}
      isBadgeHolder={view.badge.holderSeat === player.seat}
      isBadgeCandidate={view.badge.candidates.includes(player.seat)}
      showRoleBadge={player.playerId === humanPlayer?.playerId || view.phase === "GAME_END"}
      variant={variant}
    />
  );

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden">
      <GameBackground isNight={isNight} />

      <div className="relative z-10 flex h-full flex-col" data-testid="table">
        {/* 顶栏 */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--glass-border)] bg-[var(--glass-bg-weak)] px-4 py-2 backdrop-blur-md">
          <span className="text-sm font-black tracking-[0.18em] text-[var(--color-accent)]">WOLF</span>
          <span className="rounded-full border border-[var(--glass-border)] px-2.5 py-0.5 font-mono text-xs text-[var(--text-secondary)]">
            房号 {view.code}
          </span>
          <span className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
            <UsersThree size={14} />
            {view.aliveCount}/{view.players.length}
          </span>
          <span className="text-xs text-[var(--text-secondary)]">第 {view.day} 天</span>
          <span
            data-testid="phase"
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              isNight
                ? "bg-[var(--color-accent-bg)] text-[var(--color-accent)]"
                : "bg-[var(--glass-bg-strong)] text-[var(--text-primary)]"
            }`}
          >
            {phaseLabel}
            {waitingForMe && <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
          </span>
          {remainText && (
            <span className="flex items-center gap-1 rounded-full border border-[var(--glass-border)] px-2.5 py-1 font-mono text-xs text-[var(--text-secondary)]">
              <Timer size={14} />
              {remainText}
            </span>
          )}
          <span className="flex-1" />
          <span className="hidden text-xs text-[var(--text-secondary)] sm:inline">
            你是 <b data-testid="my-role" className="text-[var(--color-accent)]">{roleLabel(humanPlayer?.role)}</b>
          </span>
          {view.phase === "GAME_END" ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--glass-border)] px-3 py-1.5 text-xs text-[var(--text-primary)]"
              onClick={() => net.backToLobby()}
            >
              <SignOut size={14} />
              返回大厅
            </button>
          ) : (
            <button
              type="button"
              title="刷新状态"
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--glass-border)] px-3 py-1.5 text-xs text-[var(--text-secondary)]"
              onClick={() => void net.refresh()}
            >
              <GearSix size={14} />
              刷新
            </button>
          )}
        </div>

        {/* 主区域 */}
        <div className="flex min-h-0 flex-1 justify-center gap-3 overflow-hidden px-2 py-2 lg:gap-6 lg:px-6 lg:py-4">
          <div className="hidden w-[210px] shrink-0 flex-col gap-2 overflow-y-auto scrollbar-hide md:flex lg:w-[240px] xl:w-[260px]">
            {leftPlayers.map((player, index) => renderCard(player, index))}
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <DialogArea
              gameState={gameState}
              humanPlayer={humanPlayer}
              isNight={isNight}
              currentDialogue={null}
              displayedText=""
              isTyping={false}
              inputText={inputText}
              onInputChange={setInputText}
              onSendMessage={handleSpeak}
              onFinishSpeaking={handleFinishSpeaking}
              isHumanTurn={view.currentSpeakerSeat === humanSeat && humanSeat >= 0}
              can={view.can}
              selectedSeat={selectedSeat}
              onConfirmAction={confirmSelectedSeat}
              onCancelSelection={() => setSelectedSeat(null)}
              onNightAction={handleNightAction}
              onBadgeSignup={handleBadgeSignup}
              onWhiteWolfKingBoom={handleWhiteWolfKingBoom}
              onKnightDuel={handleKnightDuel}
              onWolfKingSelfDestruct={handleWolfKingSelfDestruct}
              onRestart={() => net.backToLobby()}
              isEventLogOpen={isEventLogOpen}
              onEventLogOpenChange={setIsEventLogOpen}
            />

            {/* 手机端玩家条 */}
            <div className="wc-mobile-player-bar mt-2 md:hidden">
              <div className="wc-mobile-player-bar__track">
                {sorted.map((player, index) => renderCard(player, index, "mobile"))}
              </div>
            </div>
          </div>

          <div className="hidden w-[210px] shrink-0 flex-col gap-2 overflow-y-auto scrollbar-hide md:flex lg:w-[240px] xl:w-[260px]">
            {rightPlayers.map((player, index) => renderCard(player, index))}
          </div>
        </div>

        {/* 笔记本（自己记身份用，纯本地） */}
        <details className="absolute bottom-3 right-3 z-40 md:bottom-4 md:right-4">
          <summary className="wc-notebook-fab cursor-pointer list-none" title="笔记本">
            <span className="text-lg">📝</span>
          </summary>
          <div className="wc-panel wc-panel--strong mt-2 h-[420px] w-[320px] max-w-[85vw] overflow-hidden rounded-xl">
            <Notebook />
          </div>
        </details>
      </div>

      {humanPlayer && (
        <RoleRevealOverlay
          open={revealOpen}
          player={humanPlayer}
          phase={gameState.phase}
          onContinue={() => setRevealOpen(false)}
        />
      )}
    </div>
  );
}