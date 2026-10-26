"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Skull, HourglassSimple, CheckCircle, Target, PaperPlaneTilt } from "@phosphor-icons/react";
import { WerewolfIcon } from "@/components/icons/FlatIcons";
import type { ChatMessage, GameState, Player } from "@/types/game";
import { isWolfRole } from "@/types/game";
import { useTranslations } from "next-intl";

interface WolfPlanningPanelProps {
  gameState: GameState;
  humanPlayer: Player | null;
  /** 狼队夜间频道：服务器只把 `scope:'wolf'` 的消息发给狼 */
  messages?: ChatMessage[];
  onChat?: (text: string) => void;
}

export function WolfPlanningPanel({ gameState, humanPlayer, messages = [], onChat }: WolfPlanningPanelProps) {
  const t = useTranslations();
  const [draft, setDraft] = useState("");
  const chat = messages.slice(-40);
  const send = () => {
    const text = draft.trim();
    if (!text || !onChat) return;
    onChat(text);
    setDraft("");
  };
  const wolves = gameState.players.filter(p => isWolfRole(p.role) && p.alive);
  const wolfVotes = gameState.nightActions.wolfVotes || {};
  const votedCount = Object.keys(wolfVotes).length;

  // 统计每个目标的票数
  const voteTargets: Record<number, { voters: Player[], target: Player | undefined }> = {};
  
  Object.entries(wolfVotes).forEach(([voterId, targetSeat]) => {
    const voter = gameState.players.find(p => p.playerId === voterId);
    const target = gameState.players.find(p => p.seat === targetSeat);
    
    if (!voteTargets[targetSeat]) {
      voteTargets[targetSeat] = { voters: [], target };
    }
    if (voter) {
      voteTargets[targetSeat].voters.push(voter);
    }
  });

  // 按票数排序
  const sortedTargets = Object.entries(voteTargets)
    .sort(([, a], [, b]) => b.voters.length - a.voters.length);

  // 判断是否达成一致
  const isConsensus = sortedTargets.length === 1 && votedCount === wolves.length;

  return (
    <div className="wc-wolf-panel bg-[#1a1512] border border-[#3e2723] rounded-lg p-4 text-[#f0e6d2]">
      {/* 标题 */}
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 bg-[var(--color-wolf)] rounded-full flex items-center justify-center">
          <WerewolfIcon size={16} className="text-white" />
        </div>
        <div>
          <div className="text-sm font-bold">{t("wolfPlanning.title")}</div>
          <div className="text-xs text-[#a09080]">{t("wolfPlanning.subtitle")}</div>
        </div>
      </div>

      {/* 狼队友状态 */}
      <div className="mb-4">
        <div className="text-xs text-[#a09080] mb-2">{t("wolfPlanning.teammateStatus")}</div>
        <div className="flex flex-col sm:flex-row gap-2">
          {wolves.map(wolf => {
          const hasVoted = wolfVotes[wolf.playerId] !== undefined;
          const votedTarget = hasVoted 
            ? gameState.players.find(p => p.seat === wolfVotes[wolf.playerId])
            : null;
          
          return (
            <motion.div
              key={wolf.playerId}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className={`flex items-center gap-2 p-2 rounded flex-1 min-w-0 ${
                wolf.isHuman ? "bg-[#3e2723]" : "bg-[#2a201a]"
              }`}
            >
              <div className="w-6 h-6 bg-[var(--color-wolf)] rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                {wolf.seat + 1}
              </div>
              <span className="text-xs sm:text-sm flex-1 min-w-0 truncate">
                {wolf.isHuman ? t("common.you") : wolf.displayName}
              </span>
              {hasVoted ? (
                <span className="flex items-center gap-1 text-[10px] sm:text-xs text-green-400 shrink-0">
                  <CheckCircle size={12} weight="fill" />
                  <span className="font-bold">
                    {t("mentions.seatLabel", { seat: wolfVotes[wolf.playerId] + 1 })}
                  </span>
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] sm:text-xs text-yellow-400 shrink-0">
                  <HourglassSimple size={12} className="animate-pulse" />
                  <span className="hidden sm:inline">{t("wolfPlanning.thinking")}</span>
                  <span className="sm:hidden">...</span>
                </span>
              )}
            </motion.div>
          );
        })}
        </div>
      </div>

      {/* 目标汇总 */}
      {sortedTargets.length > 0 && (
        <div className="border-t border-[#3e2723] pt-3">
          <div className="text-xs text-[#a09080] mb-2">{t("wolfPlanning.targetSummary")}</div>
          <AnimatePresence mode="popLayout">
            {sortedTargets.map(([targetSeat, { voters, target }]) => (
              <motion.div
                key={targetSeat}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className={`flex items-center gap-2 p-2 rounded mb-1 ${
                  isConsensus ? "bg-[var(--color-wolf)]/30 border border-[var(--color-wolf)]" : "bg-[#2a201a]"
                }`}
              >
                <Skull size={16} className="text-[var(--color-danger)]" />
                <span className="font-bold">{t("mentions.seatLabel", { seat: Number(targetSeat) + 1 })}</span>
                <span className="text-xs text-[#a09080] truncate">{target?.displayName}</span>
                <span className="ml-auto text-sm font-bold text-[var(--color-danger)]">
                  {t("wolfPlanning.votes", { count: voters.length })}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
          
          {isConsensus && (
            <div className="mt-2 text-center text-xs text-green-400 flex items-center justify-center gap-1">
              <CheckCircle size={12} weight="fill" />
              {t("wolfPlanning.consensus")}
            </div>
          )}
        </div>
      )}

      {/* 提示 */}
      {!wolfVotes[humanPlayer?.playerId || ""] && humanPlayer && isWolfRole(humanPlayer.role) && (
        <div className="mt-3 text-xs text-yellow-400 flex items-center gap-1">
          <Target size={12} />
          {t("wolfPlanning.hint")}
        </div>
      )}

      {/* 狼队夜间频道：只有狼看得到（服务器按人裁剪，好人报文里根本没有这些消息） */}
      <div className="mt-3 border-t border-[#3e2723] pt-3">
        <div className="text-xs text-[#a09080] mb-2">狼队频道（只有你们看得到）</div>
        <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
          {chat.length === 0 ? (
            <div className="text-xs text-[#6f6157]">还没人说话 —— 商量好再一起下刀。</div>
          ) : (
            chat.map((m) => (
              <div key={m.id} className="text-xs leading-snug break-words">
                <span className="font-bold text-[var(--color-wolf)]">
                  {m.playerId === humanPlayer?.playerId ? "你" : m.playerName}：
                </span>
                <span className="text-[#e8dcc8]">{m.content}</span>
              </div>
            ))
          )}
        </div>
        {onChat && (
          <div className="mt-2 flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, 200))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              maxLength={200}
              placeholder="和队友说一句话…"
              className="flex-1 min-w-0 h-8 rounded bg-[#2a201a] border border-[#3e2723] px-2 text-xs text-[#f0e6d2] placeholder:text-[#6f6157] outline-none focus:border-[var(--color-wolf)]"
            />
            <button
              type="button"
              onClick={send}
              disabled={!draft.trim()}
              className="h-8 px-2 rounded bg-[var(--color-wolf)] text-white text-xs font-bold disabled:opacity-40 flex items-center gap-1"
            >
              <PaperPlaneTilt size={12} weight="fill" />
              发送
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
