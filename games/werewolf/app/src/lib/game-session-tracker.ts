/**
 * 本地游戏会话追踪器（纯前端/静态导出/APK 用）。
 *
 * 纯前端没有自建服务端，会话 ID 只作为本地存档身份，用于刷新后恢复对局。
 * 保留与原服务端版一致的公开方法形状，方便游戏流程代码不变：
 * 所有上报/同步方法均为本地 no-op。
 */

import { generateUUID } from "./utils";

export interface GameSessionConfig {
  playerCount: number;
  difficulty?: string;
  usedCustomKey: boolean;
  modelUsed?: string;
  sessionId?: string | null;
}

export type GameSessionStatus =
  | "starting"
  | "running"
  | "failed"
  | "abandoned"
  | "completed";

interface SessionState {
  sessionId: string | null;
  startTime: number;
  config: GameSessionConfig | null;
  roundsPlayed: number;
}

const createInitialState = (): SessionState => ({
  sessionId: null,
  startTime: 0,
  config: null,
  roundsPlayed: 0,
});

let state: SessionState = createInitialState();

export const gameSessionTracker = {
  /**
   * 开始新的本地会话。返回本地 UUID 作为存档身份。
   */
  async start(config: GameSessionConfig): Promise<string | null> {
    const sessionId = config.sessionId ?? generateUUID();
    state = {
      ...createInitialState(),
      startTime: Date.now(),
      config,
      sessionId,
    };
    return sessionId;
  },

  getSessionId(): string | null {
    return state.sessionId;
  },

  async markRunning(): Promise<void> {
    // 本地模式无服务端状态。
  },

  async markFailed(): Promise<void> {
    state = createInitialState();
  },

  async abandon(): Promise<void> {
    state = createInitialState();
  },

  async incrementRound(): Promise<void> {
    state.roundsPlayed += 1;
  },

  async syncProgress(): Promise<void> {
    // 本地模式无需上报。
  },

  async syncProgressImmediate(): Promise<void> {
    // 本地模式无需上报。
  },

  async end(
    _winner: "wolf" | "villager" | null,
    _completed: boolean,
  ): Promise<void> {
    state = createInitialState();
  },

  rehydrate(sessionId: string, startedAt: number): void {
    if (!sessionId) return;
    state = {
      ...createInitialState(),
      sessionId,
      startTime: startedAt,
    };
  },

  reset() {
    state = createInitialState();
  },

  getSummary(): {
    sessionId: string;
    roundsPlayed: number;
    durationSeconds: number;
    lifecycleStatus: "running";
  } | null {
    if (!state.sessionId) return null;
    return {
      sessionId: state.sessionId,
      roundsPlayed: state.roundsPlayed,
      durationSeconds: Math.round((Date.now() - state.startTime) / 1000),
      lifecycleStatus: "running",
    };
  },
};
