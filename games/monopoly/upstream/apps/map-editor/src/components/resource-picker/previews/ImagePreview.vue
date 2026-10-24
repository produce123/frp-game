<template>
  <div class="image-preview-container">
    <img
      v-if="url"
      :src="url"
      class="preview-image"
      @error="handleImageError"
    />
    <div v-else class="preview-placeholder">
      <span class="placeholder-icon">🖼️</span>
      <span class="placeholder-text">暂无图片</span>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  url: string
}

const props = defineProps<Props>()

function handleImageError(e: Event) {
  console.error('图片加载失败:', props.url)
}
</script>

<style lang="scss" scoped>
.image-preview-container {
  width: 100%;
  aspect-ratio: 16/9;
  background-color: #f5f5f5;
  border: 1px dashed #d9d9d9;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
    justify-content: center;

  .preview-image {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .preview-placeholder {
    display: flex;
    flex-direction: column;
    align-items: center;
    color: #999;

    .placeholder-icon {
      font-size: 32px;
      margin-bottom: 8px;
    }

    .placeholder-text {
      font-size: 13px;
    }
  }
}
</style>
