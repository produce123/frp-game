<script setup lang="ts">
import { onMounted, ref } from "vue";
import gsap from "gsap";

const props = withDefaults(
	defineProps<{
		text?: string;
	}>(),
	{ text: "Mine Monopoly" },
);

// 每个字符包含：主字符、阴影1、阴影2
interface CharData {
	char: string;
	id: number;
}

const chars = ref<CharData[]>([]);
const titleEl = ref<HTMLElement | null>(null);

onMounted(() => {
	// 将文本拆分为字符数组，每个字符分配唯一 ID
	chars.value = props.text.split("").map((char, id) => ({ char, id }));

	// 等待 DOM 渲染后执行动画
	requestAnimationFrame(() => {
		if (!titleEl.value) return;
		// 获取所有层的字符元素
		const mainChars = titleEl.value.querySelectorAll(".char-main");
		const shadow1Chars = titleEl.value.querySelectorAll(".char-shadow-1");
		const shadow2Chars = titleEl.value.querySelectorAll(".char-shadow-2");

		if (mainChars.length === 0) return;

		// 同时为三层添加动画
		gsap.fromTo(
			[mainChars, shadow1Chars, shadow2Chars].flat(),
			{ y: 50, opacity: 0 },
			{
				y: 0,
				opacity: 1,
				stagger: 0.05,
				duration: 0.3,
				ease: "back.out(1.5)",
			},
		);
	});
});
</script>

<template>
	<div class="hero-title" ref="titleEl">
		<div class="text-wrapper">
			<!-- 为每个字符创建三层：主字符、阴影1、阴影2 -->
			<span v-for="{ char, id } in chars" :key="id" class="char-group">
				<span class="char-char char-shadow-2">{{ char === " " ? " " : char }}</span>
				<span class="char-char char-shadow-1">{{ char === " " ? " " : char }}</span>
				<span class="char-char char-main">{{ char === " " ? " " : char }}</span>
			</span>
		</div>
	</div>
</template>

<style lang="scss" scoped>
.hero-title {
	z-index: 1;
	margin-top: 1.875rem;

	.text-wrapper {
		font-size: 6em;
		font-weight: 600;
		letter-spacing: 0.4rem;
		display: block;
		position: relative;
		user-select: none;

		// 每个字符组
		.char-group {
			display: inline-block;
			position: relative;
		}

		// 字符层的通用样式
		.char-char {
			display: block;
			position: absolute;
			left: 0;
			top: 0;
			pointer-events: none;
		}

		// 主字符（白色，最上层）
		.char-main {
			position: relative;
			color: #ffffff;
			z-index: 1;
		}

		// 阴影1（橙色，中间层）
		.char-shadow-1 {
			color: #ff9114;
			z-index: -1;
			animation: rotate1 5s ease-in-out infinite;
		}

		// 阴影2（灰色，底层）
		.char-shadow-2 {
			color: #7e7e7e;
			z-index: -2;
			animation: rotate2 5s ease-in-out infinite;
		}
	}

	@keyframes rotate1 {
		0%,
		100% {
			-webkit-transform: translate3d(0.2rem, 0.2rem, 0.2rem);
			transform: translate3d(0.2rem, 0.2rem, 0.2rem);
		}

		50% {
			-webkit-transform: translate3d((-0.2rem, 0.2rem, -0.2rem));
			transform: translate3d((-0.2rem, 0.2rem, -0.2rem));
		}
	}

	@keyframes rotate2 {
		0%,
		100% {
			-webkit-transform: translate3d(0.3125rem, 0.3125rem, 0.3125rem);
			transform: translate3d(0.3125rem, 0.3125rem, 0.3125rem);
		}

		50% {
			-webkit-transform: translate3d((-0.3125rem, 0.3125rem, -0.3125rem));
			transform: translate3d((-0.3125rem, 0.3125rem, -0.3125rem));
		}
	}
}
</style>
