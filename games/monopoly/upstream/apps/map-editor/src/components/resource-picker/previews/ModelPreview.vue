<template>
  <div ref="containerRef" class="model-preview-container"></div>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { ModelPreviewerRenderer } from '@src/utils/three/ModelPreviewerRenderer'

interface Props {
  url: string
}

const props = defineProps<Props>()

const containerRef = ref<HTMLDivElement>()
let previewer: ModelPreviewerRenderer | null = null

// Function to initialize previewer
function initPreviewer() {
  if (!previewer && containerRef.value) {
    previewer = new ModelPreviewerRenderer(containerRef.value)
  }
}

// Function to load model
async function loadModel(url: string) {
  if (!url) return

  initPreviewer()
  if (previewer) {
    await previewer.loadModel(url, true)
  }
}

// Watch URL changes
watch(() => props.url, async (newUrl) => {
  if (newUrl) {
    await loadModel(newUrl)
  }
}, { immediate: true }) // Add immediate to trigger on component mount

onBeforeUnmount(() => {
  previewer?.destroy()
  previewer = null
})
</script>

<style lang="scss" scoped>
.model-preview-container {
  width: 100%;
  height: 150px;
  background-color: #f3f3f3;
  border-radius: 5px;
  overflow: hidden;
}
</style>
