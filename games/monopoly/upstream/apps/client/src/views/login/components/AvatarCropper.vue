<script setup lang="ts">
import { ref, watch } from 'vue';
import { Cropper, CircleStencil } from 'vue-advanced-cropper';
import 'vue-advanced-cropper/dist/style.css';
import FpDialog from "@src/components/utils/fp-dialog/fp-dialog.vue";

interface Props {
  visible: boolean;
  src: string;
}

interface Emits {
  (e: 'confirm', file: File): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const cropperRef = ref<InstanceType<typeof Cropper> | null>(null);
const isCompressing = ref(false);

// Target constraints
const TARGET_SIZE = 256;
const MAX_FILE_SIZE = 100 * 1024; // 100KB in bytes

/**
 * Compress canvas to JPEG with binary search for optimal quality
 */
async function compressToSizeLimit(canvas: HTMLCanvasElement): Promise<Blob> {
  // First, resize to target size if needed
  const workCanvas = document.createElement('canvas');
  workCanvas.width = TARGET_SIZE;
  workCanvas.height = TARGET_SIZE;
  const ctx = workCanvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  // Draw source canvas onto target size
  ctx.drawImage(canvas, 0, 0, TARGET_SIZE, TARGET_SIZE);

  // Binary search for optimal quality
  let minQuality = 0.1;
  let maxQuality = 1.0;
  let bestBlob: Blob | null = null;

  while (maxQuality - minQuality > 0.05) {
    const midQuality = (minQuality + maxQuality) / 2;
    const blob = await canvasToBlob(workCanvas, 'image/jpeg', midQuality);

    if (blob.size <= MAX_FILE_SIZE) {
      bestBlob = blob;
      minQuality = midQuality;
    } else {
      maxQuality = midQuality;
    }
  }

  // Fallback: if even min quality exceeds limit, use it anyway
  if (!bestBlob) {
    bestBlob = await canvasToBlob(workCanvas, 'image/jpeg', 0.1);
  }

  return bestBlob;
}

/**
 * Polyfill for canvas.toBlob with quality parameter
 */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      },
      type,
      quality
    );
  });
}

/**
 * Handle submit from fp-dialog: crop, compress, and emit result
 */
async function handleSubmit() {
  if (!cropperRef.value) return;

  isCompressing.value = true;
  try {
    const result = cropperRef.value.getResult();
    if (!result?.canvas) {
      console.error('Failed to get cropper result');
      return;
    }

    const compressedBlob = await compressToSizeLimit(result.canvas);

    // Convert Blob to File
    const file = new File([compressedBlob], 'avatar.jpg', { type: 'image/jpeg' });
    emit('confirm', file);
  } catch (error) {
    console.error('Compression failed:', error);
  } finally {
    isCompressing.value = false;
  }
}

/**
 * Handle cancel from fp-dialog
 */
function handleCancel() {
  emit('cancel');
}

// Cleanup object URL when dialog closes
watch(() => props.visible, (newVal) => {
  if (!newVal && props.src) {
    URL.revokeObjectURL(props.src);
  }
});
</script>

<template>
  <FpDialog
    :visible="visible"
    @update:visible="(val) => emit('update:visible', val)"
    :submit-disable="isCompressing"
    :confirm-text="isCompressing ? '处理中...' : '确认'"
    cancel-text="取消"
    title="裁剪头像"
    :style="{ width: '31.25rem', maxWidth: '90vw' }"
    @submit="handleSubmit"
    @cancel="handleCancel"
  >
    <div class="cropper-container">
      <Cropper
        ref="cropperRef"
        :src="src"
        :stencil-props="{
          aspectRatio: 1,
          movable: true,
          resizable: true,
        }"
        :stencil-component="CircleStencil"
      />
    </div>
  </FpDialog>
</template>

<style lang="scss" scoped>
.cropper-container {
  height: 21.875rem;
  border-radius: 0.5rem;
  overflow: hidden;

  :deep(.vue-advanced-cropper) {
    height: 100%;
  }
}
</style>
