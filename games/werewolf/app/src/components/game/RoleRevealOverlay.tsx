"use client";

import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  WerewolfIcon,
  WhiteWolfKingIcon,
  SeerIcon,
  WitchIcon,
  HunterIcon,
  GuardIcon,
  VillagerIcon,
  IdiotIcon,
  NightIcon,
} from "@/components/icons/FlatIcons";
import type { Phase, Player } from "@/types/game";
import { useTranslations } from "next-intl";

interface RoleRevealOverlayProps {
  open: boolean;
  player: Player;
  phase: Phase;
  onContinue: () => void;
}

type RoleMeta = {
  title: string;
  subtitle: string;
  color: string;
  bg: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  abilities: string[];
  tips: string[];
};

function getRoleMeta(role: Player["role"], t: ReturnType<typeof useTranslations>): RoleMeta {
  switch (role) {
    case "Werewolf":
      return {
        title: t("roleReveal.roles.werewolf.title"),
        subtitle: t("roleReveal.roles.werewolf.subtitle"),
        color: "var(--color-wolf)",
        bg: "var(--color-wolf-bg)",
        Icon: WerewolfIcon,
        abilities: t.raw("roleReveal.roles.werewolf.abilities"),
        tips: t.raw("roleReveal.roles.werewolf.tips"),
      };
    case "Seer":
      return {
        title: t("roleReveal.roles.seer.title"),
        subtitle: t("roleReveal.roles.seer.subtitle"),
        color: "var(--color-seer)",
        bg: "var(--color-seer-bg)",
        Icon: SeerIcon,
        abilities: t.raw("roleReveal.roles.seer.abilities"),
        tips: t.raw("roleReveal.roles.seer.tips"),
      };
    case "Witch":
      return {
        title: t("roleReveal.roles.witch.title"),
        subtitle: t("roleReveal.roles.witch.subtitle"),
        color: "var(--color-witch)",
        bg: "var(--color-witch-bg)",
        Icon: WitchIcon,
        abilities: t.raw("roleReveal.roles.witch.abilities"),
        tips: t.raw("roleReveal.roles.witch.tips"),
      };
    case "Hunter":
      return {
        title: t("roleReveal.roles.hunter.title"),
        subtitle: t("roleReveal.roles.hunter.subtitle"),
        color: "var(--color-hunter)",
        bg: "var(--color-hunter-bg)",
        Icon: HunterIcon,
        abilities: t.raw("roleReveal.roles.hunter.abilities"),
        tips: t.raw("roleReveal.roles.hunter.tips"),
      };
    case "Guard":
      return {
        title: t("roleReveal.roles.guard.title"),
        subtitle: t("roleReveal.roles.guard.subtitle"),
        color: "var(--color-guard)",
        bg: "var(--color-guard-bg)",
        Icon: GuardIcon,
        abilities: t.raw("roleReveal.roles.guard.abilities"),
        tips: t.raw("roleReveal.roles.guard.tips"),
      };
    case "Idiot":
      return {
        title: t("roleReveal.roles.idiot.title"),
        subtitle: t("roleReveal.roles.idiot.subtitle"),
        color: "var(--color-villager)",
        bg: "var(--color-villager-bg)",
        Icon: IdiotIcon,
        abilities: t.raw("roleReveal.roles.idiot.abilities"),
        tips: t.raw("roleReveal.roles.idiot.tips"),
      };
    case "WhiteWolfKing":
      return {
        title: t("roleReveal.roles.whiteWolfKing.title"),
        subtitle: t("roleReveal.roles.whiteWolfKing.subtitle"),
        color: "var(--color-wolf)",
        bg: "var(--color-wolf-bg)",
        Icon: WhiteWolfKingIcon,
        abilities: t.raw("roleReveal.roles.whiteWolfKing.abilities"),
        tips: t.raw("roleReveal.roles.whiteWolfKing.tips"),
      };
    case "EvilKnight":
      return {
        title: t("roles.evilKnight"),
        subtitle: "夜里跟着狼队刀人；夜刀和毒都杀不死你。",
        color: "var(--color-wolf)",
        bg: "var(--color-wolf-bg)",
        Icon: WerewolfIcon,
        abilities: ["永久免疫夜间刀伤和毒伤", "第一次被预言家查验，预言家次日死", "第一次被女巫毒，女巫次日死", "反伤只触发一次"],
        tips: ["不能自刀、不能自爆", "白天被投票、被猎人带走都会正常出局"],
      };
    case "WolfKing":
      return {
        title: t("roles.wolfKing"),
        subtitle: "可以自刀、自爆的狼；出局时还能开枪。",
        color: "var(--color-wolf)",
        bg: "var(--color-wolf-bg)",
        Icon: WhiteWolfKingIcon,
        abilities: ["夜里和狼队一起刀人，允许刀自己", "白天可以自爆", "被放逐、自刀、被猎人带走时可以开枪", "被毒、自爆、或自己是最后一匹狼时不能开枪"],
        tips: ["开枪可以带走一个人，也可以选择不开"],
      };
    case "WolfBeauty":
      return {
        title: t("roles.wolfBeauty"),
        subtitle: "每晚刀完人，再单独魅惑一个人。",
        color: "var(--color-wolf)",
        bg: "var(--color-wolf-bg)",
        Icon: WerewolfIcon,
        abilities: ["夜里和狼队一起刀人", "之后单独魅惑一名玩家，不能连续两晚魅惑同一人", "如果你被公投放逐，被魅惑的人跟着殉情", "被毒、夜死、自爆不会触发殉情"],
        tips: ["不能自刀、不能自爆", "被魅惑的人不会收到通知"],
      };
    case "Knight":
      return {
        title: t("roles.knight"),
        subtitle: "白天可以翻牌决斗一次，赌对方是狼。",
        color: "var(--color-hunter)",
        bg: "var(--color-hunter-bg)",
        Icon: HunterIcon,
        abilities: ["警长竞选后、放逐投票前，可以翻牌决斗一名玩家", "对方是狼：对方立刻出局，直接天黑、跳过投票", "对方是好人：你出局，白天继续正常发言投票", "一局只能决斗一次"],
        tips: ["决斗前想清楚，翻错牌就是自己出局"],
      };
    case "Elder":
      return {
        title: t("roles.elder"),
        subtitle: "你有两条命，但好人害死你会连累所有神职。",
        color: "var(--color-guard)",
        bg: "var(--color-guard-bg)",
        Icon: GuardIcon,
        abilities: ["狼人夜里要刀你两次才会死，第一刀刀不死", "女巫解药不会重置第二条命", "被投票放逐、被女巫毒死、被猎人开枪带走：所有好人神职永久失去技能", "被狼刀、白狼王带走、狼美人殉情不会封印技能"],
        tips: ["尽量别被好人误杀；你的命很贵"],
      };
    case "Gravekeeper":
      return {
        title: t("roles.gravekeeper"),
        subtitle: "每晚知道昨天公投放逐的人是好人还是狼。",
        color: "var(--color-seer)",
        bg: "var(--color-seer-bg)",
        Icon: SeerIcon,
        abilities: ["只看昨天白天公投放逐的人", "只知道阵营，不知道具体身份", "如果昨天没人被放逐，就没有信息", "被刀、被毒、被猎人带走、决斗、殉情都不算"],
        tips: ["你是被动信息神，没有主动技能", "信息可以藏在发言里，别太早暴露"],
      };
    default:
      return {
        title: t("roleReveal.roles.villager.title"),
        subtitle: t("roleReveal.roles.villager.subtitle"),
        color: "var(--color-villager)",
        bg: "var(--color-villager-bg)",
        Icon: VillagerIcon,
        abilities: t.raw("roleReveal.roles.villager.abilities"),
        tips: t.raw("roleReveal.roles.villager.tips"),
      };
  }
}

function getNextStepText(role: Player["role"], phase: Phase, t: ReturnType<typeof useTranslations>) {
  if (phase === "NIGHT_START") {
    switch (role) {
      case "Werewolf":
        return t("roleReveal.nextStep.werewolf");
      case "WhiteWolfKing":
        return t("roleReveal.nextStep.whiteWolfKing");
      case "Seer":
        return t("roleReveal.nextStep.seer");
      case "Witch":
        return t("roleReveal.nextStep.witch");
      case "Guard":
        return t("roleReveal.nextStep.guard");
      case "Hunter":
        return t("roleReveal.nextStep.hunter");
      case "Idiot":
        return t("roleReveal.nextStep.idiot");
      default:
        return t("roleReveal.nextStep.villager");
    }
  }

  return t("roleReveal.nextStep.default");
}

export function RoleRevealOverlay({ open, player, phase, onContinue }: RoleRevealOverlayProps) {
  const t = useTranslations();
  const meta = getRoleMeta(player.role, t);
  const NextStepIcon = NightIcon;

  const isNight = phase.includes("NIGHT");

  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => setRevealed(false));
    const t = window.setTimeout(() => setRevealed(true), 650);
    return () => window.clearTimeout(t);
  }, [open]);

  const cardAccent = useMemo(() => meta.color, [meta.color]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="role-reveal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[60] flex items-center justify-center wc-role-reveal-overlay"
        >
          <motion.div
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              background:
                "radial-gradient(circle at 50% 45%, rgba(255,255,255,0.08) 0%, rgba(0,0,0,0.78) 55%, rgba(0,0,0,0.92) 100%)",
            }}
          />

          <div className="relative w-full max-w-[680px] px-6 wc-role-reveal-card">
            <motion.div
              initial={{ opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className="glass-panel glass-panel--strong rounded-2xl p-1"
            >
              <div className="rounded-2xl overflow-hidden" style={{ perspective: 1200 }}>
                <motion.div
                  initial={false}
                  animate={{ rotateY: revealed ? 0 : 180 }}
                  transition={{ duration: 0.7, ease: "easeInOut" }}
                  className="relative"
                  style={{ transformStyle: "preserve-3d" }}
                >
                  <div className="absolute inset-0" style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}>
                    <div
                      className="px-6 pt-7 pb-6"
                      style={{
                        background:
                          "linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(0,0,0,0.12) 60%, rgba(0,0,0,0.25) 100%)",
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-bold tracking-wider uppercase text-white/60">{t("roleReveal.cardTitle")}</div>
                        <div className="text-xs text-white/55">{t("roleReveal.cardHint")}</div>
                      </div>
                      <div className="mt-6 flex items-center justify-center">
                        <motion.div
                          animate={{ rotate: [0, 4, -4, 0], scale: [1, 1.02, 1] }}
                          transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
                          className="w-40 h-56 rounded-3xl flex flex-col items-center justify-center gap-3"
                          style={{
                            background: "rgba(0,0,0,0.28)",
                            border: "1px solid rgba(255,255,255,0.12)",
                            boxShadow: `0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06) inset`,
                          }}
                        >
                          <div
                            className="w-14 h-14 rounded-2xl flex items-center justify-center"
                            style={{
                              background: "rgba(255,255,255,0.06)",
                              border: "1px solid rgba(255,255,255,0.10)",
                            }}
                          >
                            <meta.Icon size={28} className="text-white/90" />
                          </div>
                          <div className="text-sm font-bold text-white/85">{t("roleReveal.dealing.title")}</div>
                          <div className="text-xs text-white/55">{t("roleReveal.dealing.subtitle")}</div>
                        </motion.div>
                      </div>
                      <div className="mt-6 text-center text-sm text-white/70">{t("roleReveal.dealing.footer")}</div>
                    </div>
                  </div>

                  <div className="relative" style={{ backfaceVisibility: "hidden" }}>
                    <div
                      className="px-6 pt-7 pb-5"
                      style={{
                        background: isNight
                          ? `linear-gradient(135deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.6) 55%, rgba(0,0,0,0.26) 100%), linear-gradient(135deg, ${meta.bg} 0%, rgba(255,255,255,0.02) 55%, rgba(0,0,0,0.12) 100%)`
                          : `linear-gradient(135deg, ${meta.bg} 0%, rgba(255,255,255,0.02) 55%, rgba(0,0,0,0.12) 100%)`,
                      }}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-xs font-bold tracking-wider uppercase text-white/60">{t("roleReveal.identityLabel")}</div>
                          <div className="mt-1 flex items-center gap-3">
                            <div
                              className="w-12 h-12 rounded-2xl flex items-center justify-center"
                              style={{
                                background: "rgba(0,0,0,0.25)",
                                border: "1px solid rgba(255,255,255,0.10)",
                                boxShadow: `0 0 0 1px rgba(255,255,255,0.04) inset, 0 10px 30px rgba(0,0,0,0.35)`,
                              }}
                            >
                              <meta.Icon size={24} className="text-white" />
                            </div>
                            <div className="min-w-0">
                              <div className="text-2xl font-black tracking-tight text-white font-serif">
                                {meta.title}
                              </div>
                              <div className="mt-1 text-sm text-white/70 leading-relaxed">{meta.subtitle}</div>
                            </div>
                          </div>
                        </div>

                        <div className="shrink-0 text-right">
                          <div className="text-xs text-white/55">{t("voteResult.seatLabel", { seat: player.seat + 1 })}</div>
                          <div className="text-sm font-semibold text-white/80">{player.displayName}</div>
                        </div>
                      </div>

                      <motion.div
                        className="mt-6 h-px w-full"
                        initial={{ opacity: 0, scaleX: 0.85 }}
                        animate={{ opacity: 1, scaleX: 1 }}
                        transition={{ delay: 0.1 }}
                        style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)" }}
                      />

                      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="rounded-2xl p-4" style={{ background: "rgba(0,0,0,0.20)", border: "1px solid rgba(255,255,255,0.08)" }}>
                          <div className="text-xs font-bold tracking-wider text-white/60 uppercase">{t("roleReveal.abilitiesLabel")}</div>
                          <div className="mt-2 space-y-2">
                            {meta.abilities.map((t, i) => (
                              <div key={i} className="text-sm text-white/80 leading-relaxed">
                                {t}
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="rounded-2xl p-4" style={{ background: "rgba(0,0,0,0.20)", border: "1px solid rgba(255,255,255,0.08)" }}>
                          <div className="text-xs font-bold tracking-wider text-white/60 uppercase">{t("roleReveal.tipsLabel")}</div>
                          <div className="mt-2 space-y-2">
                            {meta.tips.map((t, i) => (
                              <div key={i} className="text-sm text-white/75 leading-relaxed">
                                {t}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="px-6 py-5" style={{ background: "rgba(0,0,0,0.25)" }}>
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-white/5 border border-white/10 text-white/80">
                          <NextStepIcon size={18} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-bold tracking-wider text-white/60 uppercase">{t("roleReveal.nextLabel")}</div>
                          <div className="mt-1 text-sm text-white/80 leading-relaxed">
                            {getNextStepText(player.role, phase, t)}
                          </div>
                        </div>
                        <div className="shrink-0">
                          <button
                            onClick={onContinue}
                            className="inline-flex items-center justify-center h-10 px-5 text-sm font-bold rounded-xl border-none cursor-pointer transition-all duration-150 bg-white text-black hover:bg-white/90 active:scale-[0.98]"
                            style={{ boxShadow: `0 10px 30px rgba(0,0,0,0.35), 0 0 0 2px ${String(cardAccent)}22` }}
                          >
                            {t("roleReveal.actions.continue")}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
