# ResourcePicker 使用指南

ResourcePicker 是一个统一的资源选择组件，用于处理图片和3D模型的选择、预览和管理。

## 基本用法

### 图片选择

```vue
<script setup>
import { ResourcePicker } from '@src/components/resource-picker'
import { ref } from 'vue'

const imageId = ref('')
</script>

<template>
  <ResourcePicker
    type="image"
    v-model="imageId"
  />
</template>
```

### 模型选择

```vue
<script setup>
import { ResourcePicker } from '@src/components/resource-picker'
import { ref } from 'vue'

const modelId = ref('')
</script>

<template>
  <ResourcePicker
    type="model"
    v-model="modelId"
  />
</template>
```

## API

### Props

| 参数 | 说明 | 类型 | 默认值 |
|------|------|------|--------|
| type | 资源类型 | 'image' \| 'model' | 必填 |
| v-model | 当前选中的资源ID | string | - |
| disabled | 是否禁用 | boolean | false |
| acceptTypes | 接受的文件类型 | string[] | [] |

### Events

| 事件名 | 说明 | 参数 |
|--------|------|------|
| update:modelValue | 资源ID更新时触发 | (value: string) |
| change | 资源变更时触发 | (resource: ResourceInfo) |

## 在表单中使用

### 表单验证

```vue
<template>
  <a-form-item
    label="角色图片"
    name="imageId"
    :rules="[{ required: true, message: '请选择角色图片' }]"
  >
    <ResourcePicker
      type="image"
      v-model="form.imageId"
    />
  </a-form-item>
</template>
```

### 编辑模式

```vue
<script setup>
import { ref, onMounted } from 'vue'

const form = ref({
  imageId: ''
})

const props = defineProps<{
  role?: Role
}>()

onMounted(() => {
  if (props.role) {
    form.value.imageId = props.role.imageId
  }
})
</script>
```

## useResourcePicker Composable

如果需要更多控制，可以直接使用 composable：

```typescript
import { useResourcePicker } from '@src/components/resource-picker'

const {
  resourceId,        // 当前资源ID
  resource,          // 完整资源信息
  resourceUrl,       // 资源URL
  isDirty,           // 是否有未保存的更改
  isLoading,         // 是否正在加载

  selectResource,    // 选择资源
  clearResource,     // 清除资源
  saveResource,      // 保存资源
  resetResource,     // 重置资源

  error              // 错误信息
} = useResourcePicker({
  type: 'image',
  initialId: props.role?.imageId,
  resourceName: props.role?.name
})
```

## 迁移指南

### 旧代码

```typescript
const fileUrl = ref('')

async function handleSelectFile() {
  const res = await window.electronAPI.showOpenDialog({
    filters: [{ name: '图片', extensions: ['png', 'jpg'] }],
    properties: ['openFile'],
  })

  if (res.filePaths.length > 0) {
    fileUrl.value = convertToFpUrl(res.filePaths[0])
  }
}

async function handleSave() {
  const imageId = await addNewImage(fileUrl.value, name)
  // ...
}
```

### 新代码

```typescript
const imageId = ref('')

async function handleSave() {
  // imageId 已经由 ResourcePicker 设置好
  // ...
}
```

```vue
<template>
  <ResourcePicker
    type="image"
    v-model="imageId"
  />
</template>
```

## 常见问题

### Q: 如何禁用资源选择器？
A: 使用 `disabled` 属性：
```vue
<ResourcePicker type="image" v-model="imageId" :disabled="true" />
```

### Q: 如何获取资源的完整信息？
A: 使用 useResourcePicker composable 的 `resource` 属性，或从 useResourceStore 获取。

### Q: 如何自定义预览？
A: 可以使用 `preview` 插槽（当前版本未实现，待后续扩展）。

## 相关文件

- 组件：`apps/map-editor/src/components/resource-picker/`
- 类型定义：`apps/map-editor/src/components/resource-picker/types.ts`
- Composable：`apps/map-editor/src/components/resource-picker/use-resource-picker.ts`
