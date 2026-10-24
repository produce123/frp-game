/**
 * 角色生成的默认输出 token 预算（单一事实源）。
 *
 * thinking 类模型的推理 token 会计入 max_tokens（例如 deepseek-v4-flash 单次思考可耗 3k+），
 * 预算不足时 content 会为空/截断，导致 “Failed to parse JSON response”。
 * UI（设置 → OpenAI 兼容网关 → 最大输出 tokens）文案也引用这些数值，改动请同步 i18n。
 */

/** 人设批次（每批 3 人）与单发补生成共用的输出上限 */
export const CHARACTER_PERSONA_BATCH_MAX_TOKENS = 7000;

/** 角色基础档案默认下限 */
export const CHARACTER_BASE_MAX_TOKENS_FLOOR = 6000;

/** 基础档案每人份的边际预算 */
export const CHARACTER_BASE_TOKENS_PER_PLAYER = 450;

/** 基础档案固定附加预算（覆盖提示词/开头尾巴开销） */
export const CHARACTER_BASE_TOKENS_EXTRA = 1800;

/** 一次性生成 count 个基础档案时的默认输出上限 */
export function getCharacterBaseProfileMaxTokens(count: number): number {
  return Math.max(
    CHARACTER_BASE_MAX_TOKENS_FLOOR,
    count * CHARACTER_BASE_TOKENS_PER_PLAYER + CHARACTER_BASE_TOKENS_EXTRA,
  );
}
