<script setup lang="ts">
import { ResourcesType, useResourceStore } from "@src/stores";
import { ModelPreviewerRenderer } from "@src/utils/three/ModelPreviewerRenderer";
import { message } from "ant-design-vue";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ model: ResourcesType | undefined }>();

let modelPreviewer: ModelPreviewerRenderer | null;

const canvasContainer = ref<HTMLDivElement>();

onMounted(() => {
	if (!props.model || !canvasContainer.value) return;
	if (!modelPreviewer) {
		modelPreviewer = new ModelPreviewerRenderer(canvasContainer.value);
	}
	modelPreviewer.loadModel(props.model.url, true);
});

watch(
	() => props.model,
	async (newModel) => {
		if (modelPreviewer && newModel) {
			await modelPreviewer.loadModel(newModel.url, true);
		}
	}
);

onBeforeUnmount(() => {
	modelPreviewer?.destroy();
	modelPreviewer = null;
});
</script>

<template>
	<div ref="canvas-container" class="model-preview-canvas-container"></div>
</template>

<style lang="scss" scoped>
.building-preview-canvas-container {
	width: 100%;
	height: 100%;
	border-radius: 5px;
	background-color: #f3f3f3;
	overflow: hidden;
}
</style>
