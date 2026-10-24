import assert from "node:assert/strict";
import test from "node:test";
import { setLocale } from "@/i18n/locale-store";
import type { GameState, Player } from "@/types/game";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||= "badge-signup-test-key";

setLocale("zh");

const makePlayer = (
  playerId: string,
  seat: number,
  role: Player["role"]
): Player => ({
  playerId,
  seat,
  displayName: `玩家${seat + 1}`,
  alive: true,
  role,
  alignment: role === "Werewolf" || role === "WhiteWolfKing" ? "wolf" : "village",
  isHuman: false,
});

const makeState = (players: Player[]): GameState => {
  return {
    gameId: "badge-signup-test",
    phase: "DAY_BADGE_SIGNUP",
    day: 1,
    difficulty: "normal",
    players,
    events: [],
    messages: [],
    currentSpeakerSeat: null,
    daySpeechStartSeat: null,
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
    nightActions: {
      seerHistory: [{ targetSeat: 1, isWolf: true, day: 1 }],
      lastGuardTarget: 0,
    },
    roleAbilities: {
      witchHealUsed: false,
      witchPoisonUsed: false,
      hunterCanShoot: true,
      idiotRevealed: false,
      whiteWolfKingBoomUsed: false,
    },
    winner: null,
  };
};

const requestText = (request: { messages: Array<{ content: string | unknown[] }> }): string =>
  request.messages
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      return message.content
        .map((part) => {
          if (typeof part === "object" && part !== null && "text" in part) {
            return String((part as { text: unknown }).text);
          }
          return "";
        })
        .join("\n");
    })
    .join("\n");

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

test("警徽报名批处理为每个玩家建立独立 Prompt，并按返回顺序映射结果", async () => {
  const restoreEnv = await installLocalGatewayEnv();
  const { generateAIBadgeSignupBatch } = await import("./game-master");
  const players = [
    makePlayer("seer", 0, "Seer"),
    makePlayer("guard", 1, "Guard"),
  ];
  const state = makeState(players);
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    messages: Array<{ content: string | unknown[] }>;
    response_format?: { type?: string; json_schema?: { strict?: boolean } };
  }> = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ content: string | unknown[] }>;
      response_format?: { type?: string; json_schema?: { strict?: boolean } };
    };
    requests.push(body);
    const text = requestText(body);
    const signup = text.includes("<your_seer_checks>");
    return Response.json({
      id: `badge-${requests.length}`,
      choices: [{
        message: { role: "assistant", content: JSON.stringify({ signup }) },
        finish_reason: "stop",
      }],
    });
  };

  try {
    const result = await generateAIBadgeSignupBatch(state, players);

    assert.equal(requests.length, players.length);
    assert.deepEqual(result, { seer: true, guard: false });
    for (const request of requests) {
      assert.equal(request.response_format?.type, "json_object");
    }

    const seerPrompt = requestText(requests[0]);
    const guardPrompt = requestText(requests[1]);
    assert.match(seerPrompt, /<your_seer_checks>/);
    assert.doesNotMatch(seerPrompt, /<your_guard_info>/);
    assert.match(guardPrompt, /<your_guard_info>/);
    assert.doesNotMatch(guardPrompt, /<your_seer_checks>/);
    assert.match(seerPrompt, /警徽竞选报名环节/);
    assert.match(guardPrompt, /警徽竞选报名环节/);
    // 输出格式为叙述式（模板内不能出现字面 JSON 花括号，否则 next-intl/ICU 解析失败并泄漏 key）
    assert.match(seerPrompt, /signup/);
    assert.match(seerPrompt, /true/);
    assert.match(seerPrompt, /false/);
    assert.match(guardPrompt, /signup/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("警徽报名单个响应非法或失败时只将对应玩家判为不上警", async () => {
  const restoreEnv = await installLocalGatewayEnv();
  const { generateAIBadgeSignupBatch } = await import("./game-master");
  const players = [
    makePlayer("p1", 0, "Villager"),
    makePlayer("p2", 1, "Villager"),
    makePlayer("p3", 2, "Villager"),
  ];
  const state = makeState(players);
  const originalFetch = globalThis.fetch;

  let callIndex = 0;
  globalThis.fetch = async () => {
    const index = callIndex;
    callIndex += 1;
    if (index === 0) {
      return Response.json({
        id: "badge-p1",
        choices: [{ message: { role: "assistant", content: '{"signup":true}' }, finish_reason: "stop" }],
      });
    }
    if (index === 1) {
      return Response.json({
        id: "badge-p2",
        choices: [{ message: { role: "assistant", content: "maybe" }, finish_reason: "stop" }],
      });
    }
    return Response.json({ error: "player request failed" }, { status: 500 });
  };

  try {
    const result = await generateAIBadgeSignupBatch(state, players);
    assert.deepEqual(result, { p1: true, p2: false, p3: false });
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
