<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{
  value?: Record<string, any>;
}>();

const emit = defineEmits(['update:value']);

interface KVItem {
  key: string;
  value: string;
}

const localList = ref<KVItem[]>([]);

watch(
  () => props.value,
  (newVal) => {
    const incomingList = Object.entries(newVal || {}).map(([k, v]) => ({
      key: k,
      value: String(v),
    }));

    const currentLocalAsObj: Record<string, string> = {};
    localList.value.forEach(item => {
      if (item.key) currentLocalAsObj[item.key] = item.value;
    });

    if (JSON.stringify(newVal || {}) === JSON.stringify(currentLocalAsObj)) {
      return; 
    }
    localList.value = incomingList;
  },
  { immediate: true, deep: true }
);

const addRow = () => {
  localList.value.push({ key: '', value: '' });
};

const removeRow = (index: number) => {
  localList.value.splice(index, 1);
  emitChange();
};

const emitChange = () => {
  const result: Record<string, any> = {};
  localList.value.forEach((item) => {
    if (item.key) {
      result[item.key] = item.value;
    }
  });
  emit('update:value', result);
};
</script>

<template>
  <div class="kv-editor">
    <div v-if="localList.length === 0" class="empty-tip">
      暂无配置
    </div>
    
    <div v-for="(item, index) in localList" :key="index" class="kv-row">
      <div class="input-group">
        <a-input
          v-model:value="item.key"
          placeholder="属性名"
          class="kv-input key-input"
          @change="emitChange"
        />
        <div class="divider">:</div>
        <a-input
          v-model:value="item.value"
          placeholder="属性值"
          class="kv-input val-input"
          @change="emitChange"
        />
      </div>
      
      <button class="icon-btn delete-btn" @click="removeRow(index)" title="删除">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    </div>

    <a-button type="dashed" block @click="addRow" class="add-btn">
      <template #icon>
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </template>
      添加属性
    </a-button>
  </div>
</template>

<style scoped>
.kv-editor {
  display: flex;
  flex-direction: column;
  gap: 8px; /* 间距稍微加大一点适应正常尺寸 Input */
}

.empty-tip {
  font-size: 13px; /* 字体稍微加大 */
  color: #ccc;
  text-align: center;
  padding: 8px 0;
  font-style: italic;
}

.kv-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #f9f9f9;
  padding: 6px; /* Padding 加大适应内容 */
  border-radius: 4px;
  border: 1px solid transparent;
  transition: all 0.2s;
}

.kv-row:hover {
  background: #f0f7ff;
  border-color: #d6e4ff;
}

.input-group {
  display: flex;
  align-items: center;
  flex: 1;
}

.divider {
  padding: 0 6px;
  color: #999;
  font-weight: bold;
  user-select: none;
}

/* 覆盖 Ant Input 样式 */
.kv-input {
  background: transparent;
  border: 1px solid transparent;
  box-shadow: none;
  font-size: 13px; /* 字体加大 */
}

.kv-input:hover, .kv-input:focus {
  background: #fff;
  border-color: #d9d9d9;
}

.key-input {
  width: 40%;
  font-weight: 500;
  color: #262626;
}

.val-input {
  flex: 1;
  color: #1890ff; 
}

.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px;
  border-radius: 4px;
  color: #999;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  opacity: 0; 
}

.kv-row:hover .icon-btn {
  opacity: 1; 
}

.icon-btn:hover {
  background: #ffccc7;
  color: #ff4d4f;
}

.add-btn {
  margin-top: 4px;
  font-size: 13px;
  border-color: #e6e6e6;
  color: #666;
}
.add-btn:hover {
  border-color: #1890ff;
  color: #1890ff;
}
</style>