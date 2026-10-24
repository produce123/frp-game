<script setup lang="ts">
import BuildingModelSeletor from "@src/views/map-editor/components/manager/components/building-model-seletor.vue";
import { useMapDataStore } from "@src/stores";
import { computed } from "vue";
import { message } from "ant-design-vue";

const visible = defineModel({ default: false });
const emits = defineEmits(["update:modelValue"]);

const buildingModelIdList = computed(() => useMapDataStore().buildingModelIdList);

function handleBuildingModelSeletorSubmit(idList: string[]) {
	useMapDataStore().buildingModelIdList = idList;
	message.success("修改默认房屋模型成功", 1);
	emits("update:modelValue", false);
}
</script>

<template>
	<a-modal title="默认的房屋模型" v-model:open="visible" destroyOnClose :footer="null">
		<building-model-seletor @submit="handleBuildingModelSeletorSubmit" :modelIdList="buildingModelIdList" />
	</a-modal>
</template>

<style lang="scss" scoped></style>
