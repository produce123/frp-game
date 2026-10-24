"use client";

/**
 * AI 行动失败 → 「重试 / 跳过」统一询问（常驻 toast）
 *
 * 对局中任一 AI 角色的 LLM 行动失败/超时时，暂停推进并弹出一个常驻 toast，
 * 由用户决定：
 *   - 「重试」：重新发起同一次 LLM 调用；
 *   - 「跳过」：沿用该环节现有的静默兜底行为（如发言=“我没啥想说的”、
 *               女巫=不用药、投票=弃权等）。
 *
 * 使用注意：
 *   - 同一时刻只允许一个挂起询问（对局内 AI 行动串行），再次询问会先取消旧的；
 *   - 游戏重置/中断时调用 cancelPendingAiRetry() 清理，避免 toast 残留或悬挂 Promise。
 */

import React from "react";
import { toast } from "sonner";
import { getLocale } from "@/i18n/locale-store";

export type AiRetryDecision = "retry" | "skip";

export interface AiRetryPromptOptions {
  /** 环节描述（已本地化），如 “女巫 使用药水” */
  label: string;
  /** 补充说明（已本地化），如超时/解析失败原因 */
  description?: string;
}

// ============================================
// 模块级挂起状态（同一时刻至多一个）
// ============================================

let pendingResolve: ((decision: AiRetryDecision) => void) | null = null;
let pendingToastId: string | number | null = null;

/** 取消当前挂起的询问（resolve "skip"，让调用方以兜底方式继续），并关闭 toast。 */
export function cancelPendingAiRetry(): void {
  const resolve = pendingResolve;
  const id = pendingToastId;
  pendingResolve = null;
  pendingToastId = null;
  if (resolve) resolve("skip");
  if (id !== null) toast.dismiss(id);
}

// ============================================
// Toast 视图（沿用 sonner 默认卡片观感 + 项目主题变量）
// ============================================

interface RetryToastViewProps {
  title: string;
  description?: string;
  onRetry: () => void;
  onSkip: () => void;
}

function RetryToastView({ title, description, onRetry, onSkip }: RetryToastViewProps) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 356,
        padding: "12px 14px",
        borderRadius: 14,
        background: "var(--bg-card, #fff)",
        color: "var(--text-primary, #222)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.14)",
        border: "1px solid rgba(0,0,0,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontFamily: "var(--font-body, ui-sans-serif, system-ui)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.35 }}>{title}</span>
      </div>
      {description ? (
        <div style={{ fontSize: 13, lineHeight: 1.45, color: "var(--text-secondary, #666)", whiteSpace: "pre-wrap" }}>
          {description}
        </div>
      ) : null}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={onSkip}
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            border: "1px solid var(--text-muted, #bbb)",
            background: "transparent",
            color: "var(--text-secondary, #666)",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {getLocale() === "zh" ? "跳过" : "Skip"}
        </button>
        <button
          type="button"
          onClick={onRetry}
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            border: "none",
            background: "var(--color-danger, #9b2c2c)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {getLocale() === "zh" ? "重试" : "Retry"}
        </button>
      </div>
    </div>
  );
}

// ============================================
// 询问入口
// ============================================

const fallbackText = () => {
  const zh = getLocale() === "zh";
  return {
    titlePrefix: zh ? "AI 行动失败" : "AI action failed",
    timeout: zh ? "已超时" : "timed out",
  };
};

/**
 * 弹出一个常驻 toast 询问「重试 / 跳过」，返回用户的决定。
 */
export function askRetryOrSkip(options: AiRetryPromptOptions): Promise<AiRetryDecision> {
  // 安全：同一时刻只保留一个挂起询问
  if (pendingResolve) {
    cancelPendingAiRetry();
  }

  return new Promise<AiRetryDecision>((resolve) => {
    const { titlePrefix } = fallbackText();
    const title = `${titlePrefix}：${options.label}`;
    const id = toast.custom(
      () => (
        <RetryToastView
          title={title}
          description={options.description}
          onRetry={() => {
            if (pendingToastId === id) pendingToastId = null;
            pendingResolve = null;
            toast.dismiss(id);
            resolve("retry");
          }}
          onSkip={() => {
            if (pendingToastId === id) pendingToastId = null;
            pendingResolve = null;
            toast.dismiss(id);
            resolve("skip");
          }}
        />
      ),
      { duration: Infinity }
    );
    pendingResolve = (decision) => {
      if (decision === "skip") resolve("skip");
      else resolve("retry");
    };
    pendingToastId = id;
  });
}

// ============================================
// 通用重试循环封装
// ============================================

export interface AiTaskRetryOptions<T> extends AiRetryPromptOptions {
  /** 发起一次 LLM 行动（应抛错以触发询问；合法返回不会被询问） */
  task: () => Promise<T>;
  /** 是否仍处于有效对局（行动前再校验）；失效时直接走 onSkip，不再打扰用户 */
  stillValid?: () => boolean;
  /** 「跳过」后采用的兜底值/兜底动作（= 各环节原有静默兜底语义） */
  onSkip: () => T | Promise<T>;
}

/**
 * 执行一次可重试的 AI 行动：
 * task 抛错 → 询问用户重试/跳过；重试则循环，跳过则执行 onSkip 返回兜底值。
 */
export async function runAiTaskWithRetry<T>(options: AiTaskRetryOptions<T>): Promise<T> {
  for (;;) {
    try {
      return await options.task();
    } catch {
      if (options.stillValid && !options.stillValid()) {
        return await options.onSkip();
      }
      const decision = await askRetryOrSkip({
        label: options.label,
        description: options.description,
      });
      if (decision === "retry") continue;
      return await options.onSkip();
    }
  }
}
