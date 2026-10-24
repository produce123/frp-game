<script setup lang="ts">
import { Buff } from "@mine-monopoly/types";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed } from "vue";

const props = defineProps<{ buff: Buff }>();

const isInfinite = computed(() => {
	const times = props.buff.triggerTimes;
	return times === -1 || times === Infinity;
});

// 转换 \n 为真实换行符
const formattedDescription = computed(() => {
	return props.buff.description.replace(/\\n/g, "\n");
});
</script>

<template>
	<div class="buff-item-card">
		<div class="fabric-strip"></div>

		<div class="content-wrapper">
			<div class="header">
				<div class="title-row">
					<span class="name">{{ buff.name }}</span>
					<span v-if="buff.triggerTiming" class="badge timing-badge">
						{{ buff.triggerTiming }}
					</span>
				</div>
			</div>

			<div class="body">
				<p class="desc-text">{{ formattedDescription }}</p>
			</div>

			<div class="footer">
				<div v-if="buff.triggerTimes != null" class="meta-tag times" :class="{ 'is-infinite': isInfinite }">
					<font-awesome-icon icon="hourglass-half" class="icon" />
					<span>{{ isInfinite ? "永久生效" : `剩余: ${buff.triggerTimes}` }}</span>
				</div>
				<div class="meta-tag source">
					<span>{{ buff.source }}</span>
				</div>
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
@use "@src/assets/variables" as *;
@use "@mine-monopoly/style/variables" as fp;

.buff-item-card {
	position: relative;
	width: 100%;
	height: min-content;
	box-sizing: border-box;

	// 基础材质：白色毛毡
	background-color: #fff;
	background-image: var(--fp-texture-felt);
	border-radius: 0.6rem;

	// 深度与阴影
	box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.05);
	border: 0.0625rem solid rgba(0, 0, 0, 0.03);

	display: flex;
	margin-bottom: 0.8rem; // 列表项间距
	transition:
		transform 0.2s,
		box-shadow 0.2s;

	&:hover {
		transform: translateY(-0.125rem);
		box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.1);
	}

	// 左侧装饰条 (织带风格)
	.fabric-strip {
		width: 0.375rem;
		border-radius: 0.6rem 0 0 0.6rem;
		background-color: var(--fp-color-primary); // 主色
		// 模拟斜纹织带纹理
		background-image: linear-gradient(
			45deg,
			rgba(255, 255, 255, 0.15) 25%,
			transparent 25%,
			transparent 50%,
			rgba(255, 255, 255, 0.15) 50%,
			rgba(255, 255, 255, 0.15) 75%,
			transparent 75%,
			transparent
		);
		background-size: 0.5rem 0.5rem;
		flex-shrink: 0;
	}

	.content-wrapper {
		flex: 1;
		display: flex;
		flex-direction: column;
		padding: 0.8rem;
	}
}

/* --- 头部区域 --- */
.header {
	margin-bottom: 0.5rem;
	padding-bottom: 0.5rem;
	border-bottom: 0.125rem dashed rgba(0, 0, 0, 0.06); // 缝线分割

	.title-row {
		display: flex;
		justify-content: space-between;
		align-items: center;

		.name {
			font-size: 1.1rem;
			color: var(--fp-color-text-primary);
		}

		.timing-badge {
			font-size: 0.75rem;
			padding: 0.15rem 0.5rem;
			border-radius: 0.25rem;
			background-color: var(--fp-color-bg-warning); // 浅橙色背景
			color: var(--fp-color-warning); // 深橙色文字
			border: 0.0625rem dashed rgba(0, 0, 0, 0.1);
		}
	}
}

/* --- 内容区域 --- */
.body {
	flex: 1;
	margin-bottom: 0.8rem;

	.desc-text {
		margin: 0;
		font-size: 0.95rem;
		color: var(--fp-color-text-regular);
		line-height: 1.5;
		text-align: justify;
		white-space: pre-wrap; /* 保留换行和空格 */
	}
}

/* --- 底部区域 --- */
.footer {
	display: flex;
	justify-content: space-between;
	align-items: center;
	font-size: 0.8rem;

	.meta-tag {
		display: flex;
		justify-content: space-around;
		align-items: center;
		gap: 0.25rem;
		background: var(--fp-color-bg-light);
		color: var(--fp-color-primary);
		padding: 0.125rem 0.5rem;
		border-radius: 0.625rem;

		&.is-infinite {
			background: var(--fp-color-bg-light);
			color: var(--fp-color-primary);
		}

		&.source {
			background: transparent; // 来源不需要背景，保持干净
			padding: 0;
			font-style: italic;
		}
	}
}
</style>
