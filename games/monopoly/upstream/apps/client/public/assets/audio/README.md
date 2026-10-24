# 音频资源目录

此目录用于存放游戏的音频资源文件。

## 目录结构

```
assets/audio/
├── bgm/                    # 背景音乐
│   └── main.mp3           # 主背景音乐（循环播放）
└── sfx/                    # 音效
    ├── button-click.mp3   # 按钮点击音效
    ├── button-hover.mp3   # 按钮悬停音效
    ├── notification.mp3   # 通知音效
    ├── success.mp3        # 成功音效
    ├── error.mp3          # 错误音效
    ├── info.mp3           # 信息提示音效
    ├── dice-roll.mp3      # 骰子滚动音效
    ├── dice-result.mp3    # 骰子结果音效
    ├── coin-collect.mp3   # 收集金币音效
    ├── coin-spend.mp3     # 消费金币音效
    ├── card-draw.mp3      # 抽卡音效
    ├── card-use.mp3       # 使用卡牌音效
    ├── property-buy.mp3   # 购买地产音效
    ├── jail.mp3           # 入狱音效
    ├── pass-go.mp3        # 经过起点音效
    ├── turn-start.mp3     # 回合开始音效
    └── turn-end.mp3       # 回合结束音效
```

## 音频格式建议

- **格式**: MP3 (推荐) 或 OGG
- **采样率**: 44.1kHz 或 48kHz
- **比特率**: 128kbps - 192kbps
- **时长建议**:
  - 背景音乐: 1-3 分钟（循环）
  - UI 音效: 0.1-0.5 秒
  - 游戏音效: 0.5-2 秒

## 添加新音效

### 方法一：使用预设音效

如果需要使用预设的音效名称，可以直接调用：

```typescript
import { useAudioManager, SoundName } from '@/utils/audio';

const audio = useAudioManager();
audio.playSound(SoundName.BUTTON_CLICK);
```

### 方法二：添加自定义音效

1. 在 `src/utils/audio/types.ts` 中添加新的音效名称：

```typescript
export enum SoundName {
	// ... 现有音效
	MY_CUSTOM_SOUND = "my-custom-sound",
}
```

2. 在 `src/utils/audio/config.ts` 中添加音效配置：

```typescript
sounds: [
	// ... 现有配置
	{
		name: SoundName.MY_CUSTOM_SOUND,
		src: "/sfx/my-custom-sound.mp3",
		type: SoundType.GAME,
		volume: 0.7,
	},
]
```

3. 将音频文件放入 `public/assets/audio/sfx/` 目录

## 音频资源下载建议

### 免费音效网站

- **Freesound**: https://freesound.org/
- **Zapsplat**: https://www.zapsplat.com/
- **Mixkit**: https://mixkit.co/free-sound-effects/
- **Pixabay**: https://pixabay.com/music/sound-effects/

### 免费背景音乐网站

- **Pixabay Music**: https://pixabay.com/music/
- **Bensound**: https://www.bensound.com/
- **Incompetech**: https://incompetech.com/music/

## 注意事项

1. 请确保使用的音频资源具有合法的使用许可
2. 建议使用较短的音频文件以加快加载速度
3. 音频文件名请使用小写字母和连字符（如 `button-click.mp3`）
4. 避免使用过大的音频文件（建议单个文件不超过 1MB）
