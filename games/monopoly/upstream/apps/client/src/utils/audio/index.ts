/**
 * 音频工具模块
 *
 * 提供音效和背景音乐的播放功能，支持音量控制和静音
 *
 * @example
 * ```typescript
 * import { useAudioManager, SoundName } from '@/utils/audio';
 *
 * const audio = useAudioManager();
 *
 * // 播放音效
 * audio.playSound(SoundName.BUTTON_CLICK);
 *
 * // 播放背景音乐
 * audio.playBGM();
 *
 * // 设置音量
 * audio.setSFXVolume(0.5);
 * audio.setBGMVolume(0.3);
 *
 * // 静音
 * audio.toggleMute();
 * ```
 */

// 导出类型
export type { SoundConfig, AudioManagerConfig, VolumeConfig } from "./types";
export { SoundType, SoundName } from "./types";

// 导出配置
export { audioConfig, getSoundPath, getBGMPath } from "./config";

// 导出音频管理器
export { useAudioManager, resetAudioManager } from "./AudioManager";
export type { AudioManager } from "./AudioManager";
export { default as audioManager } from "./AudioManager";

// 导出自动音效
export { initAutoSound } from "./auto-sound";
