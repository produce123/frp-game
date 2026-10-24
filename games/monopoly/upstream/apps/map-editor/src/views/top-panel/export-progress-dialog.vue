<script setup lang="ts">
import { computed } from "vue";

interface Props {
	open: boolean;
	percent: number;
	stage: string;
}

const props = withDefaults(defineProps<Props>(), {
	open: false,
	percent: 0,
	stage: "",
});

// 进度条颜色
const progressColor = computed(() => ({
	"0%": "#8e24aa",
	"100%": "#6200ea",
}));
</script>

<template>
	<a-modal
		:open="open"
		:closable="false"
		:footer="null"
		:maskClosable="false"
		:width="400"
		centered
		class="export-progress-modal"
	>
		<div class="export-progress-content">
			<div class="title">正在导出 .mmmap 文件</div>

			<a-progress
				:percent="percent"
				:stroke-color="progressColor"
				status="active"
			/>

			<div class="stage-text">{{ stage }}</div>

			<div class="hint-text">请勿关闭编辑器...</div>
		</div>
	</a-modal>
</template>

<style lang="scss" scoped>
.export-progress-content {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 1rem 0;

	.title {
		font-size: 1.1rem;
		font-weight: bold;
		margin-bottom: 1.5rem;
		color: #333;
	}

	.stage-text {
		margin-top: 1rem;
		color: #666;
		font-size: 0.95rem;
	}

	.hint-text {
		margin-top: 0.5rem;
		color: #999;
		font-size: 0.85rem;
	}
}
</style>
