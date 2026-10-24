<script setup lang="ts">
import { computed } from "vue";
import { RoomMapItem } from "@/interfaces/interfaces";
import StatCard from "./stat-card.vue";

const props = defineProps<{ roomList: RoomMapItem[] }>();
const emit = defineEmits<{ openRoomList: [] }>();

const totalRooms = computed(() => props.roomList.length);
const inProgressRooms = computed(() => props.roomList.filter((r) => r.isStarted).length);
</script>

<template>
	<div class="room-stats">
		<a-row :gutter="[12, 12]">
			<a-col :xs="12" :sm="12">
				<a-card class="stat-card room-card" :bordered="false" @click="emit('openRoomList')">
					<div class="stat-card-content">
						<span class="stat-icon">
							<font-awesome-icon icon="fa-solid fa-door-open" />
						</span>
						<div class="stat-info">
							<div class="stat-value">{{ totalRooms }}</div>
							<div class="stat-title">活跃房间</div>
						</div>
						<span class="card-action">
							<font-awesome-icon icon="fa-solid fa-chevron-right" />
						</span>
					</div>
				</a-card>
			</a-col>
			<a-col :xs="12" :sm="12">
				<StatCard title="游戏中" :value="inProgressRooms" icon="fa-solid fa-play" />
			</a-col>
		</a-row>
	</div>
</template>

<style lang="scss" scoped>
.room-stats {
	margin-bottom: 16px;
}

.room-card {
	cursor: pointer;
	transition: box-shadow 0.2s;

	&:hover {
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
	}

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
	}

	.stat-title {
		font-size: 12px;
		color: #999;
		margin-top: 2px;
	}

	.card-action {
		color: #bbb;
		font-size: 14px;
		flex-shrink: 0;
	}
}

@media (max-width: 576px) {
	.room-card {
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
