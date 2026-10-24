/**
 * 修饰器 skip 和 consume 使用示例
 *
 * 展示如何使用 skip() 和 consume() 来控制修饰器的次数消耗
 */

import { IModifier, ICommandContext } from "@mine-monopoly/types";

// ============== 示例 1: 条件跳过 ==============

/**
 * 护盾 Buff：只在血量充足时生效
 * 如果血量不足，跳过本次修饰器，不消耗次数
 */
const shieldBuff: IModifier<any> = {
	descriptor: {
		id: "shield-1",
		timing: "before",
		commandType: "damage",
		remainingTriggers: 3,
		meta: {
			name: "护盾",
			timingName: "受伤害前",
			description: "抵挡下一次伤害（血量>100时）",
			source: "装备"
		}
	},
	fn: async (cmd, ctx) => {
		// 假设可以从某个地方获取玩家状态
		const player = getCurrentPlayer();

		if (player.hp < 100) {
			// 血量不满时跳过，不消耗次数
			ctx.skip();
			return;
		}

		// 血量充足，护盾生效
		// ⚠️ 注意：cancel() 现在必须提供返回值
		ctx.cancel({
			damage: 0,
			blocked: true
		});
	}
};

// ============== 示例 2: 自定义消耗次数 ==============

/**
 * 暴击 Buff：暴击时消耗额外次数
 */
const heavyHitBuff: IModifier<any> = {
	descriptor: {
		id: "heavy-hit-1",
		timing: "after",
		commandType: "attack",
		remainingTriggers: 5,
		meta: {
			name: "重击",
			timingName: "攻击后",
			description: "暴击时造成双倍伤害（消耗2次）",
			source: "技能"
		}
	},
	fn: async (cmd, ctx) => {
		const isCritical = Math.random() < 0.3; // 30% 暴击率

		if (isCritical) {
			ctx.consume(2); // 暴击消耗2次

			// 双倍伤害逻辑
			const result = ctx.result as any;
			ctx.setResult({
				...result,
				damage: result.damage * 2
			});
		}

		// 默认消耗1次（如果不调用 consume）
	}
};

// ============== 示例 3: 向后兼容 ==============

/**
 * 简单 Buff：不使用新 API，保持原有行为
 */
const simpleBuff: IModifier<any> = {
	descriptor: {
		id: "simple-1",
		timing: "after",
		commandType: "move",
		remainingTriggers: 10,
		meta: {
			name: "金币加成",
			timingName: "移动后",
			description: "每次移动获得100金币",
			source: "道具"
		}
	},
	fn: async (cmd, ctx) => {
		// 不调用 skip/consume，默认消耗1次
		const player = getCurrentPlayer();
		player.gold += 100;
	}
};

// ============== 示例 4: 复杂组合 ==============

/**
 * 智能 Buff：根据多种条件决定结算方式
 */
const smartBuff: IModifier<any> = {
	descriptor: {
		id: "smart-1",
		timing: "before",
		commandType: "use-item",
		remainingTriggers: 8,
		meta: {
			name: "智能道具增强",
			timingName: "使用道具前",
			description: "根据道具类型决定消耗次数",
			source: "天赋"
		}
	},
	fn: async (cmd, ctx) => {
		const item = cmd.payload.item;

		// 场景1：药水跳过（不增强）
		if (item.id === "potion") {
			ctx.skip();
			return;
		}

		// 场景2：传说物品消耗3次（强力增强）
		if (item.rarity === "legendary") {
			ctx.consume(3);

			// 增强效果...
			const player = getCurrentPlayer();
			item.power *= 2;
			return;
		}

		// 场景3：史诗物品消耗2次
		if (item.rarity === "epic") {
			ctx.consume(2);

			// 中等增强...
			const player = getCurrentPlayer();
			item.power *= 1.5;
			return;
		}

		// 场景4：默认消耗1次（普通增强）
		// 不调用任何 API，默认消耗1次
		const player = getCurrentPlayer();
		item.power *= 1.2;
	}
};

// ============== 示例 5: 概率触发 ==============

/**
 * 概率 Buff：基于概率决定是否生效
 */
const chanceBuff: IModifier<any> = {
	descriptor: {
		id: "chance-1",
		timing: "after",
		commandType: "attack",
		remainingTriggers: 10,
		meta: {
			name: "幸运一击",
			timingName: "攻击后",
			description: "50%概率触发额外伤害",
			source: "装备"
		}
	},
	fn: async (cmd, ctx) => {
		const shouldTrigger = Math.random() < 0.5;

		if (!shouldTrigger) {
			// 未触发，跳过不消耗次数
			ctx.skip();
			return;
		}

		// 触发了，消耗1次（默认）
		const result = ctx.result as any;
		ctx.setResult({
			...result,
			damage: result.damage + 50 // 额外50点伤害
		});
	}
};

// ============== 示例 6: cancel() 的新用法 ==============

/**
 * 抵伤害修饰器：完全阻止伤害
 */
const damageBlockBuff: IModifier<any> = {
	descriptor: {
		id: "damage-block-1",
		timing: "before",
		commandType: "damage",
		remainingTriggers: 3,
		meta: {
			name: "伤害抵消",
			timingName: "受伤害前",
			description: "完全抵消下一次伤害",
			source: "护盾"
		}
	},
	fn: async (cmd, ctx) => {
		// ⚠️ cancel() 现在必须提供返回值
		// 返回值必须符合命令的 result 类型
		ctx.cancel({
			damage: 0,
			blocked: true,
			reason: "shield"
		});
	}
};

// 辅助函数（示例用）
function getCurrentPlayer(): any {
	return { hp: 150, gold: 1000 };
}
