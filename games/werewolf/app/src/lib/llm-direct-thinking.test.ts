import assert from "node:assert/strict";
import test from "node:test";

const storageValues = new Map<string, string>();
const mockStorage: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => Array.from(storageValues.keys())[index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, String(value)); },
};

async function setup(style: "auto" | "thinking" | "reasoning_effort") {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: mockStorage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    },
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: mockStorage });
  const keys = await import("@/lib/api-keys");
  keys.setOpenAIBaseUrl("https://tokendance.space/gateway/v1");
  keys.setOpenAIApiKey("test-key");
  keys.setOpenAIModel("deepseek-v4-flash-0731");
  keys.setOpenAIThinkingEnabled(true);
  keys.setOpenAIReasoningEffort("high");
  keys.setOpenAIReasoningStyle(style);
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      id: "test",
      choices: [{
        message: { role: "assistant", content: "{}", finish_reason: "stop" },
      }],
    });
  };
  return {
    bodies,
    restore: async () => {
      globalThis.fetch = originalFetch;
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
      else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
    },
  };
}

test("thinking 网关请求携带 thinking.enabled", async () => {
  const env = await setup("auto");
  try {
    const { generateCompletion } = await import("@/lib/llm");
    await generateCompletion({
      model: "deepseek-v4-flash-0731",
      messages: [{ role: "user", content: "test" }],
    });
    assert.deepEqual(env.bodies[0].thinking, { type: "enabled" });
    assert.equal("reasoning_effort" in env.bodies[0], false);
  } finally {
    await env.restore();
  }
});

test("OpenAI 标准参数继续发送 reasoning_effort", async () => {
  const env = await setup("reasoning_effort");
  try {
    const { generateCompletion } = await import("@/lib/llm");
    await generateCompletion({
      model: "deepseek-v4-flash-0731",
      messages: [{ role: "user", content: "test" }],
    });
    assert.equal(env.bodies[0].reasoning_effort, "high");
    assert.equal("thinking" in env.bodies[0], false);
  } finally {
    await env.restore();
  }
});

test("全局关闭思考时 thinking 网关收到 disabled", async () => {
  const env = await setup("thinking");
  try {
    const keys = await import("@/lib/api-keys");
    keys.setOpenAIThinkingEnabled(false);
    const { generateCompletion } = await import("@/lib/llm");
    await generateCompletion({
      model: "deepseek-v4-flash-0731",
      messages: [{ role: "user", content: "test" }],
    });
    assert.deepEqual(env.bodies[0].thinking, { type: "disabled" });
  } finally {
    await env.restore();
  }
});

test("思考过程输出多个 JSON 片段时优先取包含 profiles 的正式结果", async () => {
  const { parseLLMJsonPreferKey } = await import("@/lib/llm-json");
  const raw = `先分析 {"analysis":"狼人身份分配"} 然后输出
    {"profiles":[{"displayName":"林川","gender":"male","age":28,"mbti":"ISTJ","basicInfo":"审计"}]}`;
  const result = parseLLMJsonPreferKey<{ profiles?: Array<{ displayName: string }> }>(raw, "profiles");
  assert.equal(result?.profiles?.[0]?.displayName, "林川");
});
