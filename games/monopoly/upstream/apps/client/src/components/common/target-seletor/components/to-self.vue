<script setup lang="ts">
import { ChanceCardClientInfo, ChanceCardInfo } from "@mine-monopoly/types";
import { useGameData, useMapData } from "@src/store/game";
import { computed, inject, ref, Ref, watch, onMounted } from "vue";
import PlayerCard from "@src/views/game/components/player-card.vue";

const gameInfoStore = useGameData();
const emits = defineEmits(["target-selected"]);

const props = defineProps<{ chanceCard: ChanceCardClientInfo }>();

// 注入选中的 ID 列表（与其他 target selector 组件保持一致）
const selectedTargetIdList = inject<Ref<string[]>>("targetIdList", ref<string[]>([]));

const myPlayer = computed(() => {
	return gameInfoStore.myGameInfo;
});
const myId = computed(() => (myPlayer.value ? myPlayer.value.id : ""));

// 在组件挂载后自动设置自己为目标
onMounted(() => {
	if (myId.value) {
		selectedTargetIdList.value = [myId.value];
	}
});

const containerEl = ref<HTMLElement | null>(null);
</script>

<template>
	<div ref="containerEl" class="target-selector-container">
		<div class="target-container">
			<div class="tips">要选择自己为目标吗</div>
			<div class="target-list">
				<PlayerCard v-if="myPlayer" :id="'player-' + myPlayer.id" :player="myPlayer" :round-mark="true" />
			</div>
		</div>
	</div>
</template>

<style lang="scss" scoped>
.target-selector-container {
	display: flex;
	justify-content: space-between;

	& > .target-container {
		flex: 1;
		display: flex;
		justify-content: center;
		align-items: center;
		flex-direction: column;

		& > .target-list {
			display: flex;
			justify-content: center;
			align-items: center;
			gap: 1rem;
			margin-bottom: 2rem;

			& > div {
				box-shadow: var(--fp-shadow-md);
			}
		}
	}
}
</style>
