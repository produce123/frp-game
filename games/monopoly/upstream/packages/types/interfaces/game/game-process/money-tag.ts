/**
 * 金钱流动标签枚举
 * 用于标识金钱流动的途径，供修饰器系统识别和处理
 */
export enum MoneyTag {
	/** 系统默认操作 */
	SYSTEM = 'system',
	/** 玩家操作 */
	PLAYER = 'player',
	/** 卡片效果 */
	CARD = "card",
	/** 地产 */
	PROPOERTY = "property"
}

/**
 * 金钱流动标签类型
 * 支持预定义的枚举值或自定义字符串
 */
export type MoneyTagType = MoneyTag | string;
