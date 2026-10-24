<script setup lang="ts">
defineProps<{
	title: string;
	value: number | string;
	icon?: string;
	suffix?: string;
}>();
</script>

<template>
	<a-card class="stat-card" :bordered="false">
		<div class="stat-card-content">
			<span v-if="icon" class="stat-icon">
				<font-awesome-icon :icon="icon" />
			</span>
			<div class="stat-info">
				<div class="stat-value">
					{{ value }}
					<span v-if="suffix" class="stat-suffix">{{ suffix }}</span>
				</div>
				<div class="stat-title">{{ title }}</div>
			</div>
		</div>
	</a-card>
</template>

<style lang="scss" scoped>
.stat-card {
	.stat-card-content {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.stat-icon {
		font-size: 28px;
		color: #1890ff;
	}

	.stat-info {
		flex: 1;
		min-width: 0;
	}

	.stat-value {
		font-size: 22px;
		font-weight: 600;
		color: #333;
		line-height: 1.2;
		white-space: nowrap;
	}

	.stat-suffix {
		font-size: 13px;
		font-weight: 400;
		color: #999;
	}

	.stat-title {
		font-size: 12px;
		color: #999;
		margin-top: 2px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
}

@media (max-width: 576px) {
	.stat-card {
		.stat-icon {
			font-size: 20px;
		}

		.stat-value {
			font-size: 18px;
		}

		.stat-title {
			font-size: 11px;
		}
	}
}
</style>
