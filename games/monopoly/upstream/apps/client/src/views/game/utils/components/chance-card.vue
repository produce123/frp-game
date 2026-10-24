<template>
	<div class="chance-card" :style="{ backgroundColor: chanceCard.color }">
		<div class="chance-card-icon">
			<img :src="iconUrl" alt="icon" />
		</div>
		<div class="chance-card-content">
			<div class="chance-card-name">{{ chanceCard.name }}</div>
			<div class="chance-card-description">{{ formattedDescription }}</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ChanceCardInfo } from "@mine-monopoly/types";
import { useResourceStore } from "@src/store/game";

const props = defineProps<{
	chanceCard: ChanceCardInfo;
}>();

const resourceStore = useResourceStore();

const iconUrl = computed(() => {
	const resource = resourceStore.getRecourceById(props.chanceCard.iconId);
	return resource?.url || "";
});

// 转换 \n 为真实换行符
const formattedDescription = computed(() => {
	return props.chanceCard.description.replace(/\\n/g, "\n");
});
</script>

<style scoped>
.chance-card {
	width: 7.5rem;
	height: 10rem;
	border-radius: 0.5rem;
	padding: 0.625rem;
	box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.2);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 0.5rem;
	pointer-events: none;
	user-select: none;
}

.chance-card-icon {
	width: 3.75rem;
	height: 3.75rem;
	display: flex;
	align-items: center;
	justify-content: center;
}

.chance-card-icon img {
	width: 100%;
	height: 100%;
	object-fit: contain;
}

.chance-card-content {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 0.25rem;
	text-align: center;
}

.chance-card-name {
	font-size: 0.875rem;
	font-weight: bold;
	color: #ffffff;
	text-shadow: 0.0625rem 0.0625rem 0.125rem rgba(0, 0, 0, 0.5);
}

.chance-card-description {
	font-size: 0.625rem;
	color: #ffffff;
	text-shadow: 0.0625rem 0.0625rem 0.125rem rgba(0, 0, 0, 0.5);
	overflow: hidden;
	text-overflow: ellipsis;
	display: -webkit-box;
	-webkit-line-clamp: 3;
	-webkit-box-orient: vertical;
	white-space: pre-wrap;
}
</style>
