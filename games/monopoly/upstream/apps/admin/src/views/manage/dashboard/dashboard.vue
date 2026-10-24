<script setup lang="ts">
import { RoomMapItem } from "@/interfaces/interfaces";
import { getRoomList } from "@/utils/api/room-list";
import { onBeforeUnmount, onMounted, ref } from "vue";
import UserStats from "./components/user-stats.vue";
import GameStats from "./components/game-stats.vue";
import RoomStats from "./components/room-stats.vue";
import RoomList from "./components/room-list.vue";

const roomList = ref<RoomMapItem[]>([]);
const showRoomList = ref(false);
let setTimeOutId: any;

async function updateRoomList() {
	roomList.value = await getRoomList();
	setTimeOutId = setTimeout(updateRoomList, 2000);
}

onMounted(() => {
	updateRoomList();
});

onBeforeUnmount(() => {
	clearTimeout(setTimeOutId);
});
</script>

<template>
	<div class="dashboard">
		<RoomStats :roomList="roomList" @openRoomList="showRoomList = true" />
		<UserStats />
		<GameStats />
		<a-modal
			v-model:open="showRoomList"
			:title="`房间列表(${roomList.length})`"
			:footer="null"
			width="80%"
			:style="{ maxWidth: '900px' }"
		>
			<RoomList :roomList="roomList" />
		</a-modal>
	</div>
</template>

<style lang="scss" scoped>
.dashboard {
	padding: 10px;
}
</style>
