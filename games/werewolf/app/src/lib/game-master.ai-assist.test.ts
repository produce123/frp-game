import assert from "node:assert/strict";
import test from "node:test";
import { setLocale } from "@/i18n/locale-store";
import type { AILogEntry } from "./ai-logger";
import type { GameState, Player } from "@/types/game";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||= "ai-assist-test-key";
setLocale("zh");

const installLocalGatewayEnv = async () => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const storage = new Map<string, string>();
  const mockStorage: Storage = {
    get length() { return storage.size; },
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key) => { storage.delete(key); },
    setItem: (key, value) => { storage.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: mockStorage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: mockStorage,
  });
  const keys = await import("@/lib/api-keys");
  keys.setOpenAIBaseUrl("http://local.test/v1");
  keys.setOpenAIApiKey("test-key");
  keys.setOpenAIModel("test-model");
  keys.setOpenAIJsonObjectEnabled(true);
  return () => {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  };
};

/** 人类玩家：没有 agentProfile，这是「AI 助我」必须能跑通的前提。 */
const humanPlayer: Player = {
  playerId: "ai-assist-human",
  seat: 0,
  displayName: "真人玩家",
  alive: true,
  role: "Villager",
  alignment: "village",
  isHuman: true,
};

const aiPlayer: Player = {
  ...humanPlayer,
  playerId: "ai-assist-ai",
  seat: 1,
  displayName: "AI 玩家",
  isHuman: false,
  agentProfile: {
    modelRef: { provider: "tokendance", model: "deepseek-v4-flash-0731" },
    persona: { mbti: "INTJ", gender: "female", age: 25, voiceRules: ["简洁发言"] },
  },
};

const buildState = (): GameState => ({
  gameId: "ai-assist-test",
  phase: "DAY_SPEECH",
  day: 1,
  difficulty: "normal",
  players: [humanPlayer, aiPlayer],
  events: [],
  messages: [],
  currentSpeakerSeat: 0,
  daySpeechStartSeat: 0,
  badge: {
    holderSeat: null,
    candidates: [],
    signup: {},
    votes: {},
    allVotes: {},
    history: {},
    revoteCount: 0,
  },
  votes: {},
  voteHistory: {},
  dailySummaries: {},
  dailySummaryFacts: {},
  nightActions: {},
  roleAbilities: {
    witchHealUsed: false,
    witchPoisonUsed: false,
    hunterCanShoot: true,
    idiotRevealed: false,
    whiteWolfKingBoomUsed: false,
  },
  winner: null,
});

/** 只做草稿的入口：命中网关一次，返回可公开的发言文本。 */
test("AI 助我：不依赖 AI 人设，只返回可公开的发言草稿", async () => {
  const restoreEnv = await installLocalGatewayEnv();
  const { generateHumanSpeechSuggestion } = await import("./game-master");
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      assert.ok(url.endsWith("/chat/completions"), `unexpected ${url}`);
      const body = JSON.parse(String(init?.body));
      // 必须是正常对话补全，而不是流式；草稿不需要打字机效果。
      assert.equal(body.stream, undefined);
      assert.equal(body.model, "test-model");
      assert.equal(body.messages[0].role, "system");
      return Response.json({
        id: "test",
        choices: [{
          message: { role: "assistant", content: '["我先听听看。","这一轮我不急着站边。"]' },
          finish_reason: "stop",
        }],
      });
    };

    const draft = await generateHumanSpeechSuggestion(buildState(), humanPlayer);
    assert.equal(draft, "我先听听看。\n这一轮我不急着站边。");
    assert.equal(requestedUrls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("AI 助我：格式不合法的响应直接抛错，绝不把半截内容当草稿", async () => {
  const restoreEnv = await installLocalGatewayEnv();
  const { generateHumanSpeechSuggestion } = await import("./game-master");
  const { aiLogger } = await import("./ai-logger");
  const originalFetch = globalThis.fetch;
  const logs: AILogEntry[] = [];
  const unsubscribe = aiLogger.subscribe((entry) => {
    if (entry.request.player?.playerId === humanPlayer.playerId) logs.push(entry);
  });
  try {
    for (const content of ['{"analysis":"我是狼人，准备装预言家"}', ""]) {
      globalThis.fetch = async () => Response.json({
        id: "test",
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      });

      await assert.rejects(
        generateHumanSpeechSuggestion(buildState(), humanPlayer),
        /起草发言失败|AI failed to draft/
      );
      // 失败必须留痕：原始响应进日志，且日志里没有任何"已公开"的内容。
      assert.ok(logs.at(-1)?.error, "失败请求应写入 error");
      assert.equal(logs.at(-1)?.response.content, "");
      assert.doesNotMatch(logs.at(-1)?.response.content ?? "", /我是狼人|准备装/);
    }
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("AI 助我：玩家已写的内容作为补充说明追加，不覆盖原始上下文", async () => {
  const restoreEnv = await installLocalGatewayEnv();
  const { generateHumanSpeechSuggestion } = await import("./game-master");
  const originalFetch = globalThis.fetch;
  let lastMessages: { role: string; content: string }[] = [];
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      lastMessages = body.messages;
      return Response.json({
        id: "test",
        choices: [{ message: { role: "assistant", content: '["我倾向先投2号。"]' }, finish_reason: "stop" }],
      });
    };

    const draft = await generateHumanSpeechSuggestion(buildState(), humanPlayer, { hint: "我想先把票压到2号" });
    // 座位号沿用发言协议里的同一套净化（补全玩家名），与 AI 发言渲染一致。
    assert.equal(draft, "我倾向先投2号 AI 玩家。");
    assert.equal(lastMessages.length, 3);
    assert.equal(lastMessages[0].role, "system");
    assert.match(lastMessages[1].content, /发言/);
    assert.match(lastMessages[2].content, /我想先把票压到2号/);
    // 追加的是"玩家本人的指示"，不能被误读成别的玩家说过的话，而且必须具备约束力。
    assert.match(lastMessages[2].content, /玩家本人/);
    assert.match(lastMessages[2].content, /必须|不得/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("AI 助我：已取消的请求不发车", async () => {
  const restoreEnv = await installLocalGatewayEnv();
  const { generateHumanSpeechSuggestion } = await import("./game-master");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ id: "test", choices: [] }); };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      generateHumanSpeechSuggestion(buildState(), humanPlayer, { signal: controller.signal })
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
