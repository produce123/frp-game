# 修饰器系统 API 文档

## 概述

修饰器系统允许在命令执行前后插入自定义逻辑，支持 Buff、Debuff 等游戏机制。

## ICommandContext

### 新增/修改的方法

#### cancel(result)

取消命令执行，**必须提供返回值**。

**参数**：
- `result` (C[K]["result"]): 命令取消后的返回值（必须提供）

**使用场景**：
- 完全阻止命令执行
- 替换命令的返回值
- 护盾、免疫等机制

**示例**：
```typescript
fn: async (cmd, ctx) => {
	if (player.hasShield) {
		// ⚠️ 必须提供返回值
		ctx.cancel({
			damage: 0,
			blocked: true
		});
		return;
	}
}
```

**行为**：
- 调用后，命令执行立即中断
- 返回提供的 result 作为命令的最终结果
- Before 阶段调用后，Handler 不会执行

#### setResult(result)

设置命令执行结果。

**参数**：
- `result` (C[K]["result"]): 命令执行结果

**使用场景**：
- 修改命令的返回值
- 增强效果
- Before 阶段预处理结果

**示例**：
```typescript
fn: async (cmd, ctx) => {
	const result = ctx.result;
	ctx.setResult({
		...result,
		damage: result.damage * 2
	});
}
```

#### skip()

跳过当前修饰器的触发次数消耗。

**使用场景**：
- 条件触发：只在满足特定条件时才生效
- 概率触发：基于概率决定是否生效
- 守护机制：某些状态下不生效

**示例**：
```typescript
fn: async (cmd, ctx) => {
	if (player.hp < 100) {
		ctx.skip(); // 不满足条件，跳过不消耗次数
		return;
	}
	// 生效逻辑...
}
```

**行为**：
- 调用后，本次修饰器执行不会减少 `remainingTriggers`
- 修饰器不会被移除，下次触发仍然可能生效
- 如果多次调用，最后一次生效

#### consume(count)

自定义当前修饰器的触发次数消耗。

**参数**：
- `count` (number): 消耗的次数，必须为非负整数

**使用场景**：
- 强力效果消耗更多次数
- 根据效果强度动态调整消耗
- 特殊机制的平衡设计

**示例**：
```typescript
fn: async (cmd, ctx) => {
	if (isCriticalHit()) {
		ctx.consume(2); // 暴击消耗2次
		// 双倍伤害逻辑...
	}
	// 默认消耗1次
}
```

**行为**：
- 调用后，按照指定次数减少 `remainingTriggers`
- 如果消耗次数超过剩余次数，修饰器会被移除
- 如果多次调用，最后一次生效
- 传入负数会抛出错误

**参数验证**：
```typescript
ctx.consume(0);   // 等同于 skip()
ctx.consume(1);   // 等同于默认行为
ctx.consume(5);   // 消耗5次
ctx.consume(-1);  // 抛出错误：consume 次数不能为负数
```

## IModifierManager

### 修改的方法

#### decayAfterExecution(ids, customConsumptions?)

在修饰器执行后衰减触发次数。

**参数**：
- `ids` (string[]): 已执行的修饰器 ID 列表
- `customConsumptions` (Map<string, number>, 可选): 自定义消耗次数映射

**行为**：
- 如果 `customConsumptions` 为空，每个修饰器默认消耗 1 次
- 如果 `customConsumptions` 包含修饰器 ID，按照指定次数消耗
- 映射中的值为 0 表示跳过，不消耗次数
- 无限次数修饰器（`remainingTriggers = -1`）不受影响

**示例**：
```typescript
// 场景1: 默认消耗
manager.decayAfterExecution(["mod-1", "mod-2"]);
// mod-1: -1, mod-2: -1

// 场景2: 自定义消耗
const custom = new Map([
	["mod-1", 0],  // skip
	["mod-2", 3],  // consume(3)
	// mod-3 不在映射中，默认1次
]);
manager.decayAfterExecution(["mod-1", "mod-2", "mod-3"], custom);
// mod-1: 不变, mod-2: -3, mod-3: -1
```

## 向后兼容性

所有现有修饰器继续正常工作，无需修改代码。默认行为保持不变（每次触发消耗 1 次）。

## 迁移指南

### cancel() API 变更

**重要变更**：`cancel()` 现在必须提供返回值参数。

**旧版本**：
```typescript
fn: async (cmd, ctx) => {
	ctx.cancel(); // ❌ 不再支持
}
```

**新版本**：
```typescript
fn: async (cmd, ctx) => {
	ctx.cancel({
		damage: 0,
		blocked: true
	}); // ✅ 必须提供返回值
}
```

### 从条件判断升级到 skip

**升级前**：
```typescript
fn: async (cmd, ctx) => {
	if (condition) {
		// 不生效，但仍然消耗次数 ❌
		return;
	}
	// 生效逻辑
}
```

**升级后**：
```typescript
fn: async (cmd, ctx) => {
	if (condition) {
		ctx.skip(); // 不生效且不消耗次数 ✅
		return;
	}
	// 生效逻辑
}
```

## 常见问题

### Q: skip() 和 cancel() 有什么区别？

**A**:
- `skip()` 只影响修饰器的次数消耗，不影响命令执行
- `cancel()` 会取消整个命令的执行，**必须提供返回值**

### Q: cancel() 为什么必须提供参数？

**A**: 为了类型安全。每个命令的返回值类型都不同，硬编码返回值会导致类型错误。要求提供参数确保返回值符合命令的类型定义。

### Q: consume() 可以消耗小数吗？

**A**: 当前版本只支持整数。未来版本可能支持小数消耗。

### Q: 无限次数修饰器调用 skip/consume 有用吗？

**A**: 无效。无限次数修饰器（`remainingTriggers = -1`）永远不会被移除，调用 skip/consume 不会有任何效果。

### Q: 在修饰器外部调用 skip/consume 会怎样？

**A**: 无效果。这些方法只在修饰器 `fn` 执行期间有效。

### Q: 如何在 cancel() 后返回自定义值？

**A**: 直接将返回值作为参数传递给 `cancel()`：
```typescript
ctx.cancel({
	customField: customValue,
	// ...其他字段
});
```

## 使用示例

### 示例1：护盾 Buff

```typescript
const shieldBuff: IModifier<any> = {
	descriptor: {
		id: "shield-1",
		timing: "before",
		commandType: "damage",
		remainingTriggers: 3,
		meta: {
			name: "护盾",
			timingName: "受伤害前",
			description: "抵挡下一次伤害",
			source: "装备"
		}
	},
	fn: async (cmd, ctx) => {
		// 血量充足时才生效
		if (player.hp >= 100) {
			ctx.cancel({
				damage: 0,
				blocked: true
			});
		} else {
			// 血量不足，跳过不消耗次数
			ctx.skip();
		}
	}
};
```

### 示例2：暴击 Buff

```typescript
const critBuff: IModifier<any> = {
	descriptor: {
		id: "crit-1",
		timing: "after",
		commandType: "attack",
		remainingTriggers: 5,
		meta: {
			name: "暴击",
			timingName: "攻击后",
			description: "30%概率造成双倍伤害",
			source: "技能"
		}
	},
	fn: async (cmd, ctx) => {
		if (Math.random() < 0.3) {
			ctx.consume(2); // 暴击消耗2次
			const result = ctx.result as any;
			ctx.setResult({
				...result,
				damage: result.damage * 2
			});
		}
	}
};
```
