import { LLMJSONParser } from "ai-json-fixer";

const llmJsonParser = new LLMJSONParser();

const REASONING_TAG_NAMES = ["think", "thinking", "analysis", "reasoning", "thought"];
const REASONING_TAG_PATTERN = REASONING_TAG_NAMES.join("|");

function stripMarkdownCodeFences(text: string): string {
  let cleaned = text.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\s*/m, "");
    cleaned = cleaned.replace(/\s*```\s*$/m, "");
  }

  return cleaned.trim();
}

function stripReasoningArtifacts(text: string): string {
  if (!text) return text;

  return text
    .replace(
      new RegExp(
        `<\\s*(${REASONING_TAG_PATTERN})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>\\s*`,
        "gi"
      ),
      ""
    )
    .replace(new RegExp(`<\\s*\\/?\\s*(${REASONING_TAG_PATTERN})\\b[^>]*>`, "gi"), "")
    .trim();
}

function sanitizeLLMJsonText(raw: string): string {
  return stripReasoningArtifacts(stripMarkdownCodeFences(String(raw ?? ""))).trim();
}

function extractFirstJsonCandidate(text: string): string | null {
  return extractJsonCandidates(text)[0] ?? null;
}

/** 提取字符串中所有顶层 JSON 候选（思考过程可能输出多个对象/数组）。 */
function extractJsonCandidates(text: string): string[] {
  const results: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const objectStart = text.indexOf("{", cursor);
    const arrayStart = text.indexOf("[", cursor);
    const start =
      objectStart === -1 ? arrayStart : arrayStart === -1 ? objectStart : Math.min(objectStart, arrayStart);
    if (start === -1) break;

    const opening = text[start];
    const expectedClosing = opening === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaping = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
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
        if (ch === '"') inString = false;
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
        if (depth === 0) {
          end = i + 1;
          break;
        }
        continue;
      }
      if (opening === "{" && ch === "[") depth += 1;
      if (opening === "{" && ch === "]") {
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
      if (opening === "[" && ch === "{") depth += 1;
      if (opening === "[" && ch === "}") {
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) break;
    results.push(text.slice(start, end).trim());
    cursor = end;
  }
  return results;
}

function normalizeLooseJson(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1").trim();
}

/** 修复对象键开头引号丢失的残缺输出,如 ,age":29 → ,"age":29 */
function fixMissingKeyQuotes(text: string): string {
  return text.replace(
    /([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)(?="\s*:)/g,
    '$1"$2"',
  );
}

export function parseLLMJson<T>(raw: string): T | null {
  const cleaned = sanitizeLLMJsonText(raw);
  const extracted = extractFirstJsonCandidate(cleaned);
  const candidates = Array.from(
    new Set(
      [
        cleaned,
        fixMissingKeyQuotes(cleaned),
        extracted,
        extracted ? fixMissingKeyQuotes(extracted) : null,
      ].filter((v): v is string => !!v),
    ),
  );

  for (const candidate of candidates) {
    const variants = Array.from(new Set([candidate, normalizeLooseJson(candidate)]));
    for (const variant of variants) {
      const parsed = llmJsonParser.parse<T | string>(variant, {
        mode: "aggressive",
        stripMarkdown: true,
        trimTrailing: true,
        fixQuotes: true,
        addMissingCommas: true,
        completeStructure: true,
      });

      if (parsed == null) continue;
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed) as T;
        } catch {
          continue;
        }
      }
      return parsed;
    }
  }

  return null;
}

/**
 * 在思考/前后缀文本包含多个 JSON 片段时，优先返回顶层包含指定键
 * （如 profiles / characters）的结构化输出。
 */
export function parseLLMJsonPreferKey<T>(raw: string, key: string): T | null {
  if (!raw || !key) return parseLLMJson<T>(raw);
  const cleaned = stripReasoningArtifacts(stripMarkdownCodeFences(String(raw ?? ""))).trim();
  for (const candidate of extractJsonCandidates(cleaned)) {
    const parsed = parseLLMJson<T>(candidate);
    if (
      parsed &&
      typeof parsed === "object" &&
      key in (parsed as Record<string, unknown>)
    ) {
      return parsed;
    }
  }
  return parseLLMJson<T>(raw);
}
