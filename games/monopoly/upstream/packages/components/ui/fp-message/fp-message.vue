<script setup lang="ts">
import { computed, ref } from "vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";

const props = defineProps({
	type: {
		type: String,
		default: "info",
		validator(value: string) {
			return ["success", "warning", "error", "info"].includes(value);
		},
	},
	message: {
		type: String,
		default: "Empty Message",
	},
	delay: {
		type: Number,
		default: 3000,
	},
});

const iconList: Record<string, string> = {
	success: "circle-check",
	warning: "circle-exclamation",
	error: "circle-xmark",
	info: "circle-info",
};

const top = ref(0);
const show = ref(false);
const messageRef = ref<HTMLElement | null>(null); // DOM 引用

const classType = computed(() => ["fp-message", props.type]);
const iconName = computed(() => `fa-solid fa-${iconList[props.type]}`);

function setTop(newValue: number) {
	top.value = newValue;
}

function setVisible(newState: boolean) {
	return new Promise((resolve) => {
		show.value = newState;
		let timer: any = setTimeout(() => {
			clearTimeout(timer);
			timer = null;
			resolve("");
		}, 200);
	});
}

// 获取当前的实际像素高度 (DOM API 只能拿到 px)
function getHeightPx() {
	return messageRef.value?.offsetHeight || 0;
}

defineExpose({
	setVisible,
	setTop,
	getHeightPx,
});
</script>

<template>
	<transition name="fp">
		<div ref="messageRef" :style="{ top: top + 'rem' }" v-show="show" :class="classType">
			<font-awesome-icon class="icon" :icon="iconName" />
			<span class="text">{{ message }}</span>
		</div>
	</transition>
</template>

<style lang="scss" scoped>
.fp-message {
	position: absolute;
	left: 50%;
	transform: translateX(-50%);

	/* 核心修改：改为 Flex 布局，高度自适应 */
	display: flex;
	align-items: center;
	min-width: 20rem;
	max-width: 40rem; /* 建议限制最大宽度防止太长 */
	min-height: 2.8rem; /* 保持原有的最小高度 */
	// height: 2.8rem;  /* 删除固定高度 */
	// line-height: 2.8rem; /* 删除固定行高 */

	padding: 0.6rem 0.8rem; /* 改为四周填充，适应多行 */
	border-radius: 0.4rem;
	border: 0.12rem solid;
	z-index: var(--z-message);
	transition: top 0.2s ease-in-out;
	font-family: "ContentFont";
	box-sizing: border-box; /* 确保 padding 不撑大尺寸计算 */

	& > .icon {
		margin-right: 0.5rem;
		font-size: 1.2rem;
		flex-shrink: 0; /* 防止图标被压缩 */
	}

	& > .text {
		line-height: 1.5; /* 优化多行文本阅读体验 */
		word-break: break-word;
		white-space: pre-wrap;
		text-align: left;
	}

	&.success {
		background-color: #e1f3d8;
		border-color: #d1edc4;
		color: #529b2e;
	}

	&.warning {
		background-color: #faecd8;
		border-color: #f8e3c5;
		color: #b88230;
	}

	&.error {
		background-color: #fde2e2;
		border-color: #fcd3d3;
		color: #c45656;
	}

	&.info {
		background-color: #cedfff;
		border-color: #a8d4ff;
		color: #095fce;
	}
}

.fp-enter-active,
.fp-leave-active {
	transition: all 0.2s ease-out;
}

.fp-enter-from,
.fp-leave-to {
	transform: translate(-50%, -20px);
	opacity: 0;
}
</style>
