<script setup lang="ts">
import { onMounted, ref } from "vue";
import MapForm from "./components/map-form.vue";
import { GameMapInDb } from "@mine-monopoly/types";
import { getGameMapInfo, getGameMapList } from "@/utils/api/game-map";
import MapItem from "./components/map-item.vue";

const formVisible = ref(false);
const currentGameMap = ref<GameMapInDb | undefined>();
const gameMapList = ref<GameMapInDb[]>([]);

const total = ref(0);
const currentPage = ref(1);
const pageSize = ref(6);

async function updateList() {
	const { gameMapList: list, total: _total } = await getGameMapList(currentPage.value, pageSize.value);
	gameMapList.value = list;
	total.value = _total;
}

async function handleGameMapCreated() {
	formVisible.value = false;
	await updateList();
}

async function handleGameMapEdit(mapInfo: GameMapInDb) {
	currentGameMap.value = mapInfo;
	formVisible.value = true;
}

function handleFormClose() {
	currentGameMap.value = undefined;
}

onMounted(async () => {
	updateList();
});
</script>

<template>
	<div class="map-manager">
		<div class="top-bar">
			<div class="left">
				<h4>地图管理</h4>
			</div>
			<div class="right">
				<a-button @click="formVisible = true" type="primary">上传地图</a-button>
			</div>
		</div>

		<a-empty style="flex: 1" v-if="total === 0" description="没有数据" />
		<a-row v-else :gutter="[12, 12]" class="map-item-container">
			<a-col :xs="24" :sm="12" :lg="8" v-for="mapInfo in gameMapList" :key="mapInfo.id">
				<map-item
					@edit="handleGameMapEdit"
					@deleted="updateList"
					@changed="updateList"
					:map-info="mapInfo"
				/>
			</a-col>
		</a-row>

		<a-pagination
			class="map-pagination"
			v-model:current="currentPage"
			:show-total="() => `${total} 个地图`"
			:total="total"
			:pageSize="pageSize"
			show-less-items
		/>
	</div>

	<a-modal
		@close="handleFormClose"
		destroyOnClose
		title="上传地图"
		:width="'min(500px, 90vw)'"
		v-model:open="formVisible"
		:footer="null"
	>
		<map-form @finish="handleGameMapCreated" :game-map="currentGameMap" />
	</a-modal>
</template>

<style lang="scss" scoped>
.map-manager {
	padding: 10px;
	display: flex;
	flex-direction: column;
	height: 100%;

	.top-bar {
		width: 100%;
		display: flex;
		justify-content: space-between;
		align-items: center;
		background-color: #fff;
		padding: 10px 20px;
		border-radius: 5px;
	}

	.map-item-container {
		flex: 1;
		padding: 10px;
	}

	.map-pagination {
		text-align: right;
	}
}
</style>
