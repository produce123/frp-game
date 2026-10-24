/**
 * MiniMax TTS 浏览器直连（纯前端）。
 *
 * 与原先 /api/tts 代理等价，但由浏览器直接请求 MiniMax：
 * 需要玩家在设置中填写自己的 MiniMax API Key 与 Group ID。
 * 调用失败由调用方（AudioManager）捕获并静默降级为纯字幕。
 */

import { getMinimaxApiKey, getMinimaxGroupId, hasMinimaxKey } from "@/lib/api-keys";

const PRIMARY_BASE_URL = "https://api.minimaxi.com";
const FALLBACK_BASE_URL = "https://api.minimax.chat";
const TTS_MODEL = "speech-01-turbo";

interface MiniMaxTtsPayload {
  model: string;
  text: string;
  stream: false;
  voice_setting: {
    voice_id: string;
    speed: number;
    vol: number;
    pitch: number;
  };
  audio_setting: {
    sample_rate: number;
    bitrate: number;
    format: "mp3";
    channel: number;
  };
}

function parseErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    const baseResp = parsed as { base_resp?: { status_msg?: string } };
    if (baseResp.base_resp?.status_msg) return baseResp.base_resp.status_msg;
  } catch {
    // Not JSON; fall through.
  }
  return text.slice(0, 600);
}

export function isTTSConfigured(): boolean {
  return hasMinimaxKey();
}

export async function synthesizeSpeech(
  text: string,
  voiceId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const apiKey = getMinimaxApiKey().trim();
  const groupId = getMinimaxGroupId().trim();
  if (!apiKey || !groupId) {
    throw new Error("MiniMax API Key 与 Group ID 未配置");
  }
  if (!text.trim() || !voiceId.trim()) {
    throw new Error("Missing text or voiceId");
  }

  const payload: MiniMaxTtsPayload = {
    model: TTS_MODEL,
    text,
    stream: false,
    voice_setting: {
      voice_id: voiceId,
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    },
  };

  let lastError: unknown = null;
  for (const baseUrl of [PRIMARY_BASE_URL, FALLBACK_BASE_URL]) {
    try {
      const url = `${baseUrl}/v1/t2a_v2?GroupId=${encodeURIComponent(groupId)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          GroupId: groupId,
        },
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`MiniMax API error: ${parseErrorMessage(errorText)}`);
      }
      const blob = await response.blob();
      if (blob.size === 0) throw new Error("MiniMax returned empty audio");
      return blob;
    } catch (error) {
      lastError = error;
      signal?.throwIfAborted();
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("MiniMax TTS fetch failed");
}
