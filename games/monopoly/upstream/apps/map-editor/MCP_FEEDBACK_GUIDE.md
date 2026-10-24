# MCP 操作反馈机制使用指南

## 概述

本地图编辑器已实现 MCP (Model Context Protocol) 工具操作后的实时反馈机制。当 AI 通过 MCP 工具修改地图时，编辑器会自动显示操作结果的通知消息。

## 功能特性

### ✅ 自动反馈

所有 MCP 修改操作都会自动触发反馈通知，包括：

- **地图项目操作**：添加、删除、更新、链接、取消链接
- **地图事件操作**：添加、删除、链接事件
- **角色操作**：添加、更新、删除角色
- **机会卡操作**：添加、删除机会卡
- **游戏阶段操作**：添加、更新、删除游戏阶段
- **UI 模板操作**：添加、更新、删除 UI 模板
- **自定义 UI 操作**：添加、更新、删除自定义 UI
- **游戏设置操作**：更新游戏设置表单
- **额外库操作**：更新额外库代码
- **地图路径操作**：更新地图索引路径

### 🎨 反馈样式

- **成功操作**：绿色成功消息（使用 Ant Design Vue 的 `message.success`）
- **失败操作**：红色错误消息（使用 Ant Design Vue 的 `message.error`）
- **详细信息**：包含操作类型、简要说明和相关 ID

## 技术实现

### 1. 事件总线（Event Bus）

在 `src/utils/event-bus/index.ts` 中定义了 `mcp-operation` 事件：

```typescript
type Events = {
	// ... 其他事件
	"mcp-operation": {
		operation: string;
		success: boolean;
		message: string;
		details?: any;
	};
};
```

### 2. 桥接处理器（Bridge Handler）

在 `src/mcp/bridge-handler.ts` 中，每个修改操作都会调用 `sendMCPFeedback` 函数：

```typescript
function sendMCPFeedback(operation: string, success: boolean, message: string, details?: any) {
	eventBus.emit("mcp-operation", {
		operation,
		success,
		message,
		details,
	});
}
```

### 3. UI 显示（App.vue）

在主应用中监听 `mcp-operation` 事件并显示通知：

```typescript
const handleMCPOperation = (data: {
	operation: string;
	success: boolean;
	message: string;
	details?: any;
}) => {
	if (data.success) {
		message.success(data.message);
	} else {
		message.error(data.message);
	}
};

onMounted(() => {
	removeMCPListener = eventBus.on("mcp-operation", handleMCPOperation);
});
```

## 反馈示例

### 示例 1：添加地图项目

**操作**：AI 调用 `add_map_item` 添加新的地图项目

**反馈消息**：
```
✅ 添加地图项目成功 (5, 10)
```

### 示例 2：链接地图项目

**操作**：AI 调用 `link_map_items` 链接两个地图项目

**反馈消息**：
```
✅ 链接地图项目成功
```

### 示例 3：添加角色

**操作**：AI 调用 `add_role` 添加新角色

**反馈消息**：
```
✅ 添加角色成功: 地产大亨
```

### 示例 4：更新游戏设置

**操作**：AI 调用 `update_game_setting_form` 更新游戏设置

**反馈消息**：
```
✅ 更新游戏设置表单成功
```

### 示例 5：操作失败

**操作**：AI 调用工具时发生错误

**反馈消息**：
```
❌ 操作失败: MapItemType with ID xxx not found
```

## 扩展自定义反馈

如果需要为自定义操作添加反馈，只需：

1. 在相应的 MCP 工具处理函数中调用 `sendMCPFeedback`
2. 传递适当的参数：
   - `operation`: 操作名称
   - `success`: 成功或失败
   - `message`: 用户友好的消息
   - `details`: 可选的详细信息对象

### 示例：添加自定义反馈

```typescript
// 在 bridge-handler.ts 中
case "your_custom_tool": {
	// 执行操作...
	try {
		// 你的逻辑
		const result = await doSomething(args);

		// 发送成功反馈
		sendMCPFeedback(
			"your_custom_tool",
			true,
			`自定义操作成功: ${result.name}`,
			{ id: result.id }
		);

		return result;
	} catch (error) {
		// 发送失败反馈
		sendMCPFeedback(
			"your_custom_tool",
			false,
			`自定义操作失败: ${error.message}`
		);
		throw error;
	}
}
```

## 调试

### 查看反馈日志

所有 MCP 操作反馈都会在浏览器控制台输出：

```javascript
console.log("MCP 操作反馈:", data);
```

### 测试反馈功能

1. 打开地图编辑器
2. 打开浏览器开发者工具（F12）
3. 通过 AI 调用任何 MCP 修改工具
4. 查看右上角的通知消息和控制台日志

## 注意事项

1. **事件监听器清理**：在组件卸载时会自动清理事件监听器，避免内存泄漏

2. **异步处理**：反馈事件是异步触发的，不会阻塞 MCP 工具的执行

3. **错误处理**：所有错误都会通过 `catch` 块捕获并发送失败反馈

4. **用户友好**：消息文本使用中文，简洁明了地说明操作结果

## 未来改进

可能的增强功能：

- [ ] 添加撤销/重做功能
- [ ] 显示操作历史记录面板
- [ ] 支持批量操作的汇总反馈
- [ ] 添加操作进度条（对于耗时操作）
- [ ] 自定义通知样式和位置
- [ ] 添加通知音效

## 相关文件

- `src/utils/event-bus/index.ts` - 事件总线定义
- `src/mcp/bridge-handler.ts` - MCP 工具处理和反馈发送
- `src/App.vue` - UI 反馈监听和显示
- `src/mcp/bridge.ts` - MCP 桥接接口定义
