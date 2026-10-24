import { Directive } from "vue";
import { useAudioManager, SoundName } from "@src/utils/audio";

/**
 * 音效指令配置
 */
interface SoundDirectiveBinding {
	value?: SoundName | string;
	modifiers?: {
		hover?: boolean;
		debounce?: boolean;
	};
}

/**
 * 音效指令
 * 为元素添加点击和悬停音效
 *
 * @example
 * ```vue
 * <!-- 默认按钮点击音效 -->
 * <button v-sound>点击我</button>
 *
 * <!-- 悬停音效 -->
 * <button v-sound.hover>悬停播放</button>
 *
 * <!-- 指定音效类型 -->
 * <button v-sound="'success'">成功按钮</button>
 *
 * <!-- 点击 + 悬停音效 -->
 * <button v-sound.hover>点击和悬停</button>
 * ```
 */
const soundDirective: Directive<HTMLElement, SoundName | string | undefined> = {
	mounted(el: HTMLElement, binding: SoundDirectiveBinding) {
		const audio = useAudioManager();
		const soundName = (binding.value || SoundName.BUTTON_CLICK) as SoundName;

		// 防抖延迟（毫秒）
		const debounceMs = binding.modifiers?.debounce ? 300 : 0;
		let lastClick = 0;
		let lastHover = 0;

		// 点击音效
		const handleClick = () => {
			const now = Date.now();
			if (debounceMs > 0 && now - lastClick < debounceMs) {
				return;
			}
			lastClick = now;
			audio.playSound(soundName);
		};

		// 悬停音效
		const handleMouseEnter = () => {
			const now = Date.now();
			if (debounceMs > 0 && now - lastHover < debounceMs) {
				return;
			}
			lastHover = now;
			audio.playSound(SoundName.BUTTON_HOVER);
		};

		// 绑定点击事件
		el.addEventListener("click", handleClick, { passive: true });

		// 如果有 hover 修饰符，绑定悬停事件
		if (binding.modifiers?.hover) {
			el.addEventListener("mouseenter", handleMouseEnter, { passive: true });
		}

		// 保存清理函数
		(el as any)._soundDirectiveCleanup = () => {
			el.removeEventListener("click", handleClick);
			if (binding.modifiers?.hover) {
				el.removeEventListener("mouseenter", handleMouseEnter);
			}
		};
	},

	unmounted(el: HTMLElement) {
		// 清理事件监听
		const cleanup = (el as any)._soundDirectiveCleanup;
		if (cleanup) {
			cleanup();
		}
	},
};

export default soundDirective;
