/**
 * LLM 客户端（纯前端）。
 *
 * 所有 AI 调用都通过浏览器直连玩家配置的 OpenAI 兼容网关
 * (`/chat/completions`)。无任何自建服务端 / API 代理。
 */

import {
  getOpenAIApiKey,
  getOpenAIBaseUrl,
  getOpenAIMaxTokens,
  getOpenAIModel,
  getOpenAIJsonObjectEnabled,
  getOpenAIReasoningEffort,
  getOpenAIThinkingEnabled,
  isOpenAICompatConfigured,
} from "@/lib/api-keys";
import type { ModelRef } from "@/types/game";
import type { PromptScope } from "@/lib/deepseek-prompt-scope";
import { parseLLMJson, parseLLMJsonPreferKey } from "./llm-json";
import {
  generateCompletionBatchDirect,
  generateCompletionDirect,
  generateCompletionStreamDirect,
} from "./llm-direct";

export type LLMContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "input_audio"; input_audio: { data: string; format: "mp3" | "wav" } };

/** 纯前端模式下 API Key 恒为用户在本机配置的 Key。 */
export type ApiKeySource = "user" | "project";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string | LLMContentPart[];
  reasoning_details?: unknown;
}

export type Provider = "zenmux" | "dashscope" | "tokendance" | "openai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveApiKeySource(_model: string): ApiKeySource {
  // 纯前端版本没有服务端托管的项目 Key；统一按用户 Key 记录。
  return "user";
}

export interface ChatCompletionResponse {
  id: string;
  choices: {
    message: {
      role: "assistant";
      content: string;
      reasoning_details?: unknown;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    } | null;
  };
}

export interface PromptCacheUsage {
  promptCacheInputTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  promptCacheHitRatio: number;
  source: "prompt_cache_hit_tokens" | "prompt_tokens_details.cached_tokens" | "none";
}

export function extractPromptCacheUsage(usage: ChatCompletionResponse["usage"] | undefined): PromptCacheUsage {
  const promptTokens =
    typeof usage?.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens)
      ? usage.prompt_tokens
      : 0;

  if (typeof usage?.prompt_cache_hit_tokens === "number") {
    const hit = Math.max(0, usage.prompt_cache_hit_tokens);
    const miss =
      typeof usage.prompt_cache_miss_tokens === "number"
        ? Math.max(0, usage.prompt_cache_miss_tokens)
        : Math.max(0, promptTokens - hit);
    const input = hit + miss || promptTokens;
    return {
      promptCacheInputTokens: input,
      promptCacheHitTokens: hit,
      promptCacheMissTokens: miss,
      promptCacheHitRatio: input > 0 ? hit / input : 0,
      source: "prompt_cache_hit_tokens",
    };
  }

  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  if (typeof cachedTokens === "number" && Number.isFinite(cachedTokens)) {
    const hit = Math.max(0, cachedTokens);
    const miss = Math.max(0, promptTokens - hit);
    return {
      promptCacheInputTokens: promptTokens,
      promptCacheHitTokens: hit,
      promptCacheMissTokens: miss,
      promptCacheHitRatio: promptTokens > 0 ? hit / promptTokens : 0,
      source: "prompt_tokens_details.cached_tokens",
    };
  }

  return {
    promptCacheInputTokens: promptTokens,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: promptTokens,
    promptCacheHitRatio: 0,
    source: "none",
  };
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        description?: string;
        strict?: boolean;
        schema: unknown;
      };
    };

export interface ReasoningOptions {
  enabled: boolean;
  effort?: "minimal" | "low" | "medium" | "high" | "max";
  max_tokens?: number;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  model: string;
  provider?: Provider;
  promptScope?: PromptScope;
  messages: LLMMessage[];
  temperature?: number;
  max_tokens?: number;
  reasoning?: ReasoningOptions;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "max";
  response_format?: ResponseFormat;
  /** 解析结构化 JSON 时优先挑选顶层包含这些键的片段（思考可能输出多个 JSON）。 */
  preferRootKeys?: string[];
}

/** 保留 modelRef 的展示/存档语义，不改变实际请求模型。 */
export function mergeOptionsFromModelRef<T extends GenerateOptions>(
  modelRef: ModelRef | undefined,
  options: T
): T {
  if (!modelRef) return options;
  const out = { ...options } as T;
  (out as GenerateOptions).provider = modelRef.provider;
  if (modelRef.temperature !== undefined) (out as GenerateOptions).temperature = modelRef.temperature;
  if (modelRef.reasoning !== undefined) (out as GenerateOptions).reasoning = modelRef.reasoning;
  return out;
}

const OPENAI_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "max"]);

function applyOpenAICompatOverride<T extends GenerateOptions>(options: T): T {
  if (!isOpenAICompatConfigured()) return options;
  const out = { ...options } as T;
  const enabled = getOpenAIThinkingEnabled();
  const rawEffort = getOpenAIReasoningEffort();
  const effort =
    OPENAI_REASONING_EFFORTS.has(rawEffort)
      ? (rawEffort as "minimal" | "low" | "medium" | "high" | "max")
      : undefined;
  out.model = getOpenAIModel();
  out.provider = "openai";
  out.reasoning = {
    enabled,
    ...(enabled && effort ? { effort } : {}),
  };
  out.reasoning_effort = undefined;

  // 全局最大输出 tokens：设置了则覆盖每个请求的默认预算。
  // thinking 类模型会把推理 token 计入 max_tokens，预算不足时 content 可能为空/截断。
  const maxTokensOverride = getOpenAIMaxTokens();
  if (maxTokensOverride !== null) out.max_tokens = maxTokensOverride;

  const jsonObjectEnabled = getOpenAIJsonObjectEnabled();
  const rf = options.response_format as { type?: string } | undefined;
  if (!jsonObjectEnabled) {
    out.response_format = undefined;
  } else if (rf && rf.type === "json_schema") {
    // 网关不支持 json_schema：降级为 json_object。
    // 注意：各结构化调用的 prompt 模板自身带输出格式示例（含 "json"/字段说明），
    // 保证字段稳定；不要在此处改写 messages（会破坏 aiLogger↔传输消息一致性审计）。
    out.response_format = { type: "json_object" as const };
  }
  return out;
}

export type BatchCompletionResult =
  | { ok: true; content: string; reasoning_details?: unknown; raw: ChatCompletionResponse }
  | { ok: false; error: string; status?: number };

const QUOTA_EXHAUSTED_MARKER = "[QUOTA_EXHAUSTED]";
const GAME_SESSION_EXPIRED_MARKER = "[GAME_SESSION_EXPIRED]";

export function isQuotaExhaustedMessage(message: string): boolean {
  return message.includes(QUOTA_EXHAUSTED_MARKER);
}

export function isGameSessionExpiredMessage(message: string): boolean {
  return message.includes(GAME_SESSION_EXPIRED_MARKER);
}

export function readStreamProtocolError(payload: unknown): string | null {
  if (!isRecord(payload) || !("error" in payload)) return null;
  const rawError = payload.error;
  if (rawError == null) return null;
  const error = isRecord(rawError) ? rawError : payload;
  const message = typeof error.message === "string"
    ? error.message
    : typeof rawError === "string"
      ? rawError
      : "模型流式响应失败";
  const lower = message.toLowerCase();
  if (
    lower.includes("insufficient") ||
    lower.includes("quota") ||
    lower.includes("balance") ||
    lower.includes("余额")
  ) {
    return `${QUOTA_EXHAUSTED_MARKER} ${message}`;
  }
  return message;
}

/** 剥离模型在 content 中嵌入的 <think>/<reasoning> 等思考块 */
const REASONING_TAG_NAMES = ["think", "thinking", "analysis", "reasoning", "thought"];
const REASONING_TAG_PATTERN = REASONING_TAG_NAMES.join("|");

function stripReasoningArtifactsPreserveWhitespace(text: string): string {
  if (!text) return text;
  return text
    .replace(
      new RegExp(
        `<\\s*(${REASONING_TAG_PATTERN})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>\\s*`,
        "gi"
      ),
      ""
    )
    .replace(new RegExp(`<\\s*\\/?\\s*(${REASONING_TAG_PATTERN})\\b[^>]*>`, "gi"), "");
}

export function stripReasoningArtifacts(text: string): string {
  return stripReasoningArtifactsPreserveWhitespace(text).trim();
}

export function stripMarkdownCodeFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z0-9_-]*\s*/m, "");
    t = t.replace(/\s*```\s*$/m, "");
  }
  return t.trim();
}

function stripJsonPrefix(text: string): string {
  const t = text.trimStart();
  if (/^json\s*[\[{]/i.test(t)) return t.replace(/^json\s*/i, "");
  return text;
}

function extractFirstJsonBlock(text: string): string | null {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  const start =
    startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
  if (start === -1) return null;

  const opening = text[start];
  const expectedClosing = opening === "{" ? "}" : "]";
  let i = start;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opening) {
      depth += 1;
      continue;
    }
    if (ch === expectedClosing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
      continue;
    }
    if (opening === "{" && ch === "[") depth += 1;
    if (opening === "{" && ch === "]") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) return text.slice(start, i + 1);
    }
    if (opening === "[" && ch === "{") depth += 1;
    if (opening === "[" && ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeJsonText(text: string): string {
  return text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function escapeDanglingQuotesInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaping = false;
  const nextNonWs = (idx: number): string | null => {
    for (let j = idx; j < text.length; j += 1) {
      const c = text[j];
      if (!/\s/.test(c)) return c;
    }
    return null;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaping) {
      escaping = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      const n = nextNonWs(i + 1);
      const isTerminator = n === null || n === "," || n === "}" || n === "]" || n === ":";
      if (isTerminator) {
        inString = false;
        out += ch;
        continue;
      }
      out += "\\\"";
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonTolerant<T>(raw: string, preferRootKeys?: string[]): T {
  const trimmed = stripJsonPrefix(stripMarkdownCodeFences(raw));
  for (const key of preferRootKeys ?? []) {
    const preferred = parseLLMJsonPreferKey<T>(trimmed, key);
    if (preferred !== null) return preferred;
  }
  const repairedJson = parseLLMJson<T>(trimmed);
  if (repairedJson !== null) return repairedJson;
  const direct = normalizeJsonText(trimmed);
  try {
    return JSON.parse(direct) as T;
  } catch {
    // continue
  }
  const extracted = extractFirstJsonBlock(direct) ?? extractFirstJsonBlock(trimmed);
  if (!extracted) throw new Error(`Failed to parse JSON response: ${raw}`);
  const normalized = normalizeJsonText(extracted);
  try {
    return JSON.parse(normalized) as T;
  } catch {
    // continue
  }
  const repaired = escapeDanglingQuotesInStrings(normalized);
  try {
    return JSON.parse(repaired) as T;
  } catch {
    throw new Error(`Failed to parse JSON response: ${raw}`);
  }
}

function assertGatewayConfigured(): void {
  if (!isOpenAICompatConfigured()) {
    throw new Error(
      "尚未配置 LLM 网关：请在设置中填写 OpenAI 兼容网关地址、API Key 与模型后再开局。",
    );
  }
}

export async function generateCompletion(
  options: GenerateOptions,
): Promise<{ content: string; reasoning_details?: unknown; raw: ChatCompletionResponse }> {
  const overridden = applyOpenAICompatOverride(options);
  overridden.signal?.throwIfAborted();
  assertGatewayConfigured();
  return generateCompletionDirect(overridden);
}

export async function generateCompletionBatch(
  requests: GenerateOptions[],
): Promise<BatchCompletionResult[]> {
  if (!Array.isArray(requests) || requests.length === 0) return [];
  const overridden = requests.map((request) => applyOpenAICompatOverride(request));
  assertGatewayConfigured();
  return generateCompletionBatchDirect(overridden);
}

export async function* generateCompletionStream(
  options: GenerateOptions,
): AsyncGenerator<string, void, unknown> {
  const overridden = applyOpenAICompatOverride(options);
  overridden.signal?.throwIfAborted();
  assertGatewayConfigured();
  yield* generateCompletionStreamDirect(overridden);
}

export async function generateJSON<T>(
  options: GenerateOptions & { schema?: string }
): Promise<T> {
  const messagesWithFormat = [...options.messages];
  const lastMessage = messagesWithFormat[messagesWithFormat.length - 1];
  if (lastMessage && lastMessage.role === "user") {
    const suffix =
      "\n\nRespond with valid JSON only. No markdown, no code blocks, just raw JSON. If you need to include double quotes inside string values, escape them as \\\".";
    if (typeof lastMessage.content === "string") {
      lastMessage.content += suffix;
    } else if (Array.isArray(lastMessage.content)) {
      const parts = lastMessage.content;
      const lastPart = parts[parts.length - 1];
      if (lastPart && lastPart.type === "text") {
        lastPart.text += suffix;
      } else {
        parts.push({ type: "text", text: suffix });
      }
    }
  }
  const result = await generateCompletion({
    ...options,
    messages: messagesWithFormat,
  });
  return parseJsonTolerant<T>(result.content, options.preferRootKeys);
}

// 供 llm-direct 使用：网关 Key 也可以直接在这里读取。
export { getOpenAIApiKey, getOpenAIBaseUrl };
