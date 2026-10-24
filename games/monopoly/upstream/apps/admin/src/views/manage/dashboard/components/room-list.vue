<script setup lang="ts">
import { RoomMapItem } from "@/interfaces/interfaces";
import RoomItem from "./room-item.vue";

defineProps<{ roomList: RoomMapItem[] }>();
</script>

<template>
	<div class="room-list-section">
		<div class="room-list">
			<RoomItem v-for="room in roomList" :key="room.roomId" :room="room" />
		</div>
		<a-empty v-if="roomList.length === 0" description="暂无活跃房间" style="margin-top: 20px" />
	</div>
</template>

<style lang="scss" scoped>
.room-list-section {
	.room-list {
		max-height: 60vh;
		overflow-y: auto;
		padding: 4px;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 16px;
	}
}
</style>
