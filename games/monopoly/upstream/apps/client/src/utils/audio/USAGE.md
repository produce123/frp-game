# 音频系统使用指南

## 快速开始

### 基础使用

```typescript
import { useAudioManager, SoundName } from '@/utils/audio';

const audio = useAudioManager();

// 播放音效
audio.playSound(SoundName.BUTTON_CLICK);

// 播放背景音乐
audio.playBGM();
```

### 在 Vue 组件中使用

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useAudioManager, SoundName } from '@/utils/audio';
import { useSettig } from '@/store';

const audio = useAudioManager();
const settingStore = useSettig();

const handleClick = () => {
  audio.playSound(SoundName.BUTTON_CLICK);
};

const toggleMusic = () => {
  if (audio.isBGMPlaying()) {
    audio.stopBGM();
  } else {
    audio.playBGM();
  }
};
</script>

<template>
  <div>
    <!-- 音量控制 -->
    <a-slider
      v-model:value="settingStore.masterVolume"
      :min="0"
      :max="1"
      :step="0.01"
      @change="audio.setMasterVolume(settingStore.masterVolume)"
    />

    <!-- 静音按钮 -->
    <a-button @click="audio.toggleMute">
      {{ settingStore.muted ? '取消静音' : '静音' }}
    </a-button>

    <!-- 播放音效 -->
    <a-button @click="handleClick">播放音效</a-button>

    <!-- 背景音乐控制 -->
    <a-button @click="toggleMusic">
      {{ audio.isBGMPlaying() ? '停止音乐' : '播放音乐' }}
    </a-button>
  </div>
</template>
```

## API 参考

### AudioManager

#### 播放控制

| 方法 | 说明 |
|------|------|
| `playSound(soundName: SoundName)` | 播放指定音效 |
| `playBGM()` | 播放背景音乐 |
| `stopBGM()` | 停止背景音乐 |
| `pauseBGM()` | 暂停背景音乐 |
| `fadeInBGM(duration?: number)` | 淡入背景音乐（默认 1 秒） |
| `fadeOutBGM(duration?: number)` | 淡出背景音乐（默认 1 秒） |
| `stopAll()` | 停止所有音频 |
| `unload()` | 卸载所有音频资源 |

#### 音量控制

| 方法 | 说明 |
|------|------|
| `setMasterVolume(volume: number)` | 设置主音量 (0-1) |
| `setSFXVolume(volume: number)` | 设置音效音量 (0-1) |
| `setBGMVolume(volume: number)` | 设置背景音乐音量 (0-1) |
| `toggleMute()` | 切换静音状态 |
| `setMute(muted: boolean)` | 设置静音状态 |
| `setAutoMusic(autoMusic: boolean)` | 设置是否自动播放背景音乐 |

#### 状态查询

| 方法 | 说明 |
|------|------|
| `getVolumeConfig()` | 获取当前音量配置 |
| `isBGMPlaying()` | 背景音乐是否正在播放 |

### 预设音效 (SoundName)

#### UI 音效

- `BUTTON_CLICK` - 按钮点击
- `BUTTON_HOVER` - 按钮悬停
- `NOTIFICATION` - 通知
- `SUCCESS` - 成功提示
- `ERROR` - 错误提示
- `INFO` - 信息提示

#### 游戏音效

- `DICE_ROLL` - 骰子滚动
- `DICE_RESULT` - 骰子结果
- `COIN_COLLECT` - 收集金币
- `COIN_SPEND` - 消费金币
- `CARD_DRAW` - 抽卡
- `CARD_USE` - 使用卡牌
- `PROPERTY_BUY` - 购买地产
- `JAIL` - 入狱
- `PASS_GO` - 经过起点
- `TURN_START` - 回合开始
- `TURN_END` - 回合结束

## 与 Pinia Store 集成

音频系统已与 `useSettig` store 集成，音量设置会自动保存到 localStorage：

```typescript
import { useSettig } from '@/store';

const settingStore = useSettig();

// 这些设置会自动保存并在页面刷新后恢复
settingStore.masterVolume = 0.8;  // 主音量
settingStore.sfxVolume = 0.6;     // 音效音量
settingStore.musicVolume = 0.4;   // 背景音乐音量
settingStore.muted = false;       // 静音
settingStore.autoMusic = true;    // 自动播放背景音乐
```

## 音量设置界面示例

```vue
<template>
  <a-card title="音频设置">
    <a-space direction="vertical" style="width: 100%">

      <!-- 主音量 -->
      <div>
        <div>主音量: {{ Math.round(settingStore.masterVolume * 100) }}%</div>
        <a-slider
          v-model:value="settingStore.masterVolume"
          :min="0"
          :max="1"
          :step="0.01"
        />
      </div>

      <!-- 音效音量 -->
      <div>
        <div>音效音量: {{ Math.round(settingStore.sfxVolume * 100) }}%</div>
        <a-slider
          v-model:value="settingStore.sfxVolume"
          :min="0"
          :max="1"
          :step="0.01"
        />
      </div>

      <!-- 背景音乐音量 -->
      <div>
        <div>背景音乐: {{ Math.round(settingStore.musicVolume * 100) }}%</div>
        <a-slider
          v-model:value="settingStore.musicVolume"
          :min="0"
          :max="1"
          :step="0.01"
        />
      </div>

      <!-- 自动播放背景音乐 -->
      <a-checkbox v-model:checked="settingStore.autoMusic">
        自动播放背景音乐
      </a-checkbox>

      <!-- 静音 -->
      <a-checkbox v-model:checked="settingStore.muted" @change="handleMuteChange">
        静音
      </a-checkbox>

    </a-space>
  </a-card>
</template>

<script setup lang="ts">
import { useAudioManager, SoundName } from '@/utils/audio';
import { useSettig } from '@/store';

const audio = useAudioManager();
const settingStore = useSettig();

const handleMuteChange = () => {
  audio.setMute(settingStore.muted);
};
</script>
```

## 常见使用场景

### 按钮点击音效

```vue
<template>
  <a-button @click="handleClick">
    点击我
  </a-button>
</template>

<script setup lang="ts">
import { useAudioManager, SoundName } from '@/utils/audio';

const audio = useAudioManager();

const handleClick = () => {
  audio.playSound(SoundName.BUTTON_CLICK);
  // ... 其他业务逻辑
};
</script>
```

### 全局指令方式（可选扩展）

如果需要在多个按钮上自动添加音效，可以创建 Vue 指令：

```typescript
// main.ts
import { useAudioManager, SoundName } from '@/utils/audio';

app.directive('sound', {
  mounted(el, binding) {
    const soundName = binding.value || SoundName.BUTTON_CLICK;
    el.addEventListener('click', () => {
      useAudioManager().playSound(soundName);
    });
  }
});
```

```vue
<!-- 使用指令 -->
<template>
  <a-button v-sound="SoundName.SUCCESS">按钮</a-button>
</template>
```

## 注意事项

1. **音效预加载**: 所有音效在初始化时预加载，首次加载可能会有短暂延迟
2. **浏览器限制**: 某些浏览器要求用户交互后才能播放音频
3. **音量计算**: 实际播放音量 = 主音量 × 分类音量（音效/背景音乐）
4. **文件路径**: 音频文件必须放在 `public/assets/audio/` 目录下
