# @mine-monopoly/style

Fatpaper 统一样式变量系统。

## 安装

```bash
pnpm install
```

## 构建

```bash
# 生成类型定义和编译 CSS
pnpm build

# 仅生成类型
pnpm generate-types

# 监听 SCSS 变化
pnpm watch

# 启动预览服务器
pnpm preview
```

## 预览

运行 `pnpm preview` 后，在浏览器中打开预览页面可以查看所有样式变量的效果：

- 品牌色、语义色、背景色、文字色展示
- 间距、字体、阴影效果演示
- 层级关系可视化
- 毛毡风格纹理效果
- 代码使用示例

## 使用方法

### SCSS 变量

在组件中导入 SCSS 变量：

```scss
@use '@mine-monopoly/style/src/variables' as fp;

.my-component {
  color: fp.$fp-color-primary;
  padding: fp.$fp-spacing-md;
  font-size: fp.$fp-font-size-base;
}
```

### TypeScript 类型

在 TypeScript 代码中使用类型定义：

```ts
import { FpColors, FpSpacing, FpVarNames } from '@mine-monopoly/style';

// 类型安全的颜色值
const primaryColor: keyof typeof FpColors = 'primary';

// CSS 变量名
const primaryVar = FpVarNames.colorPrimary; // '--fp-color-primary'

// 运行时辅助函数
import { fpColor, fpSpacing } from '@mine-monopoly/style';

const buttonStyle = {
  color: fpColor('primary'), // 'var(--fp-color-primary)'
  padding: fpSpacing('md'),  // 'var(--fp-spacing-md)'
};
```

### CSS 自定义属性

在 Vue 模板中直接使用 CSS 变量：

```vue
<template>
  <div class="box">内容</div>
</template>

<style>
.box {
  color: var(--fp-color-primary);
  background: var(--fp-color-bg-light);
  padding: var(--fp-spacing-md);
}
</style>
```

## 命名规范

- 颜色：`$fp-color-{semantic}-{variant}`
- 间距：`$fp-spacing-{size}`
- 字体：`$fp-font-{property}-{variant}`
- 阴影：`$fp-shadow-{elevation}`
- 层级：`$fp-layer-{name}`

## 可用变量

### 颜色
- 品牌色：`primary`, `secondary`, `tertiary`
- 语义色：`success`, `warning`, `error`, `info`, `message`
- 文字色：`text-primary`, `text-secondary`, `text-placeholder` 等
- 背景色：`bg`, `bg-light`, `bg-disable` 等
- 边框色：`border-base`, `border-light` 等

### 间距
- `xs`: 4px
- `sm`: 8px
- `md`: 16px
- `lg`: 24px
- `xl`: 32px
- `xxl`: 48px

### 字体
- 大小：`xs`(12px), `sm`(14px), `base`(16px), `lg`(18px), `xl`(20px), `xxl`(24px)
- 字重：`light`(300), `normal`(400), `medium`(500), `bold`(700)
- 行高：`tight`(1.25), `normal`(1.5), `relaxed`(1.75)

### 层级
- `background`: 0
- `game`: 10
- `ui`: 20
- `fly-item`: 30
- `dialog`: 70
- `loading`: 90
- `topbar`: 100
