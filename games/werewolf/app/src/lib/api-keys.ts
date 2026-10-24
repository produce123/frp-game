/**
 * 本地连接配置（纯前端）。
 *
 * 只保存两类玩家自填配置：
 * - OpenAI 兼容 LLM 网关（地址 / Key / 模型），浏览器直连；
 * - MiniMax TTS（可选），浏览器直连。
 * 所有内容都只写入当前设备 localStorage，不涉及任何账号或服务端。
 */

import {
  GENERATOR_MODEL,
  REVIEW_MODEL,
  SUMMARY_MODEL,
} from "@/types/game";

const OPENAI_BASE_URL_STORAGE = "wolfcha_openai_base_url";
const OPENAI_API_KEY_STORAGE = "wolfcha_openai_api_key";
const OPENAI_MODEL_STORAGE = "wolfcha_openai_model";
const OPENAI_THINKING_STORAGE = "wolfcha_openai_thinking_enabled";
const OPENAI_EFFORT_STORAGE = "wolfcha_openai_reasoning_effort";
const OPENAI_REASONING_STYLE_STORAGE = "wolfcha_openai_reasoning_style";
const OPENAI_JSON_OBJECT_STORAGE = "wolfcha_openai_json_object_enabled";
const OPENAI_MAX_TOKENS_STORAGE = "wolfcha_openai_max_tokens";
const OPENAI_DIRECT_STORAGE = "wolfcha_openai_direct";
const MODEL_SOURCE_STORAGE = "wolfcha_model_source";
const MINIMAX_API_KEY_STORAGE = "wolfcha_minimax_api_key";
const MINIMAX_GROUP_ID_STORAGE = "wolfcha_minimax_group_id";
const GENERATOR_MODEL_STORAGE = "wolfcha_generator_model";
const SUMMARY_MODEL_STORAGE = "wolfcha_summary_model";
const REVIEW_MODEL_STORAGE = "wolfcha_review_model";
const SELECTED_MODELS_STORAGE = "wolfcha_selected_models";

export const MODEL_SOURCE_CHANGE_EVENT = "wolfcha:model-source-change";

export type ModelSource = "project" | "custom";

export type ReasoningStyle = "auto" | "thinking" | "reasoning_effort";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readStorage(key: string): string {
  if (!canUseStorage()) return "";
  const value = window.localStorage.getItem(key);
  return typeof value === "string" ? value.trim() : "";
}

function writeStorage(key: string, value: string) {
  if (!canUseStorage()) return;
  const trimmed = value.trim();
  if (!trimmed) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, trimmed);
}

// OpenAI-compatible gateway
export function getOpenAIBaseUrl(): string {
  return readStorage(OPENAI_BASE_URL_STORAGE);
}

export function getOpenAIApiKey(): string {
  return readStorage(OPENAI_API_KEY_STORAGE);
}

export function getOpenAIModel(): string {
  return readStorage(OPENAI_MODEL_STORAGE);
}

export function getOpenAIThinkingEnabled(): boolean {
  return readStorage(OPENAI_THINKING_STORAGE) === "true";
}

export function getOpenAIReasoningEffort(): string {
  return readStorage(OPENAI_EFFORT_STORAGE);
}

export function isOpenAICompatConfigured(): boolean {
  return Boolean(
    getOpenAIBaseUrl() && getOpenAIApiKey() && getOpenAIModel(),
  );
}

export function setOpenAIBaseUrl(url: string) {
  writeStorage(OPENAI_BASE_URL_STORAGE, url);
}

export function setOpenAIApiKey(key: string) {
  writeStorage(OPENAI_API_KEY_STORAGE, key);
}

export function setOpenAIModel(model: string) {
  writeStorage(OPENAI_MODEL_STORAGE, model);
}

export function setOpenAIThinkingEnabled(enabled: boolean) {
  writeStorage(OPENAI_THINKING_STORAGE, enabled ? "true" : "");
}

export function setOpenAIReasoningEffort(effort: string) {
  writeStorage(OPENAI_EFFORT_STORAGE, effort);
}

export function getOpenAIReasoningStyle(): ReasoningStyle {
  const stored = readStorage(OPENAI_REASONING_STYLE_STORAGE);
  return stored === "thinking" || stored === "reasoning_effort" ? stored : "auto";
}

export function setOpenAIReasoningStyle(style: ReasoningStyle) {
  writeStorage(OPENAI_REASONING_STYLE_STORAGE, style);
}

/** 未显式配置时默认开启（向后兼容）。 */
export function getOpenAIJsonObjectEnabled(): boolean {
  return readStorage(OPENAI_JSON_OBJECT_STORAGE) !== "false";
}

export function setOpenAIJsonObjectEnabled(enabled: boolean) {
  writeStorage(OPENAI_JSON_OBJECT_STORAGE, enabled ? "true" : "false");
}

/** 全局最大输出 tokens（可覆盖各调用默认值）；未配置返回 null。thinking 类模型会把推理 token 计入该预算。 */
export function getOpenAIMaxTokens(): number | null {
  const raw = readStorage(OPENAI_MAX_TOKENS_STORAGE);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** 保存全局最大输出 tokens；传空串/非法值表示清空（使用各调用默认）。 */
export function setOpenAIMaxTokens(value: string) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    writeStorage(OPENAI_MAX_TOKENS_STORAGE, String(parsed));
  } else {
    writeStorage(OPENAI_MAX_TOKENS_STORAGE, "");
  }
}

export function getOpenAIProxyEnabled(): boolean {
  return readStorage(OPENAI_DIRECT_STORAGE) === "true";
}

export function setOpenAIProxyEnabled(enabled: boolean) {
  writeStorage(OPENAI_DIRECT_STORAGE, enabled ? "true" : "");
}

export function isOpenAIDirectActive(): boolean {
  return isOpenAICompatConfigured() && !getOpenAIProxyEnabled();
}

// MiniMax TTS
export function getMinimaxApiKey(): string {
  return readStorage(MINIMAX_API_KEY_STORAGE);
}

export function setMinimaxApiKey(key: string) {
  writeStorage(MINIMAX_API_KEY_STORAGE, key);
}

export function getMinimaxGroupId(): string {
  return readStorage(MINIMAX_GROUP_ID_STORAGE);
}

export function setMinimaxGroupId(id: string) {
  writeStorage(MINIMAX_GROUP_ID_STORAGE, id);
}

export function hasMinimaxKey(): boolean {
  return Boolean(getMinimaxApiKey() && getMinimaxGroupId());
}

// 兼容旧模块调用的“多服务商”字段：纯前端不再使用，统一返回空。
export function getZenmuxApiKey(): string {
  return "";
}
export function setZenmuxApiKey(_key: string) {}
export function hasZenmuxKey(): boolean {
  return false;
}
export function getDashscopeApiKey(): string {
  return "";
}
export function setDashscopeApiKey(_key: string) {}
export function hasDashscopeKey(): boolean {
  return false;
}
export function getTokendanceApiKey(): string {
  return "";
}
export function setTokendanceApiKey(_key: string) {}
export function hasTokendanceKey(): boolean {
  return false;
}
export function getTokendanceBaseUrl(): string {
  return "";
}
export function setTokendanceBaseUrl() {}

export function resolveAiVoiceAvailability(
  _source: ModelSource,
  hasCustomTtsKey: boolean,
): boolean {
  return hasCustomTtsKey;
}

export function getModelSource(): ModelSource {
  if (!canUseStorage()) return "project";
  return isOpenAICompatConfigured() ? "custom" : "project";
}

export function setModelSource(source: ModelSource) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(MODEL_SOURCE_STORAGE, source);
  window.dispatchEvent(new CustomEvent(MODEL_SOURCE_CHANGE_EVENT, { detail: source }));
}

export function isCustomKeyEnabled(): boolean {
  return isOpenAICompatConfigured();
}

export function setCustomKeyEnabled(value: boolean) {
  setModelSource(value ? "custom" : "project");
}

export function getSelectedModels(): string[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(SELECTED_MODELS_STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

export function setSelectedModels(_models: string[]) {
  writeStorage(SELECTED_MODELS_STORAGE, "");
}

function configuredOr(model: string, fallback: string): string {
  return isOpenAICompatConfigured() ? getOpenAIModel() : readStorage(model) || fallback;
}

export function getGeneratorModel(): string {
  return configuredOr(GENERATOR_MODEL_STORAGE, GENERATOR_MODEL);
}

export function setGeneratorModel(model: string) {
  writeStorage(GENERATOR_MODEL_STORAGE, model);
}

export function getSummaryModel(): string {
  return configuredOr(SUMMARY_MODEL_STORAGE, SUMMARY_MODEL);
}

export function setSummaryModel(model: string) {
  writeStorage(SUMMARY_MODEL_STORAGE, model);
}

export function getReviewModel(): string {
  return configuredOr(REVIEW_MODEL_STORAGE, REVIEW_MODEL);
}

export function setReviewModel(model: string) {
  writeStorage(REVIEW_MODEL_STORAGE, model);
}

export function clearApiKeys() {
  if (!canUseStorage()) return;
  window.localStorage.removeItem(OPENAI_BASE_URL_STORAGE);
  window.localStorage.removeItem(OPENAI_API_KEY_STORAGE);
  window.localStorage.removeItem(OPENAI_MODEL_STORAGE);
  window.localStorage.removeItem(OPENAI_THINKING_STORAGE);
  window.localStorage.removeItem(OPENAI_EFFORT_STORAGE);
  window.localStorage.removeItem(OPENAI_REASONING_STYLE_STORAGE);
  window.localStorage.removeItem(OPENAI_JSON_OBJECT_STORAGE);
  window.localStorage.removeItem(OPENAI_MAX_TOKENS_STORAGE);
  window.localStorage.removeItem(OPENAI_DIRECT_STORAGE);
  window.localStorage.removeItem(MINIMAX_API_KEY_STORAGE);
  window.localStorage.removeItem(MINIMAX_GROUP_ID_STORAGE);
  window.localStorage.removeItem(GENERATOR_MODEL_STORAGE);
  window.localStorage.removeItem(SUMMARY_MODEL_STORAGE);
  window.localStorage.removeItem(REVIEW_MODEL_STORAGE);
  window.localStorage.removeItem(SELECTED_MODELS_STORAGE);
  window.localStorage.setItem(MODEL_SOURCE_STORAGE, "project");
  window.dispatchEvent(new CustomEvent(MODEL_SOURCE_CHANGE_EVENT, { detail: "project" }));
}

export interface KeyValidationResult {
  valid: boolean;
  error?: string;
  errorCode?: string;
}

export async function validateApiKeyBalance(): Promise<KeyValidationResult> {
  if (isOpenAICompatConfigured()) return { valid: true };
  return {
    valid: false,
    error: "未配置 LLM 网关",
    errorCode: "no_key",
  };
}
