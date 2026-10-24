import { IPlayer } from "../game-process";
import { ICommandMap } from "./command";

/**
 * 地产命令映射
 * 定义所有与地产相关的命令类型、负载和结果
 */
export interface PropertyCommandMap extends ICommandMap {
	// ===== 地产主人相关命令 =====

	/**
	 * 地产主人变更
	 */
	"property.owner.change": {
		payload: { oldOwner: IPlayer | undefined; newOwner: IPlayer | undefined };
		result: { oldOwner: IPlayer | undefined; newOwner: IPlayer | undefined };
	};

	// ===== 地产等级相关命令 =====

	/**
	 * 地产升级
	 */
	"property.level.up": {
		payload: {};
		result: {};
	};

	/**
	 * 地产降级
	 */
	"property.level.down": {
		payload: {};
		result: {};
	};

	/**
	 * 地产等级设置
	 */
	"property.level.set": {
		payload: { oldLevel: number; newLevel: number };
		result: { oldLevel: number; newLevel: number };
	};

	// ===== 地产到达事件 =====

	/**
	 * 玩家到达地产
	 */
	"property.arrived": {
		payload: { owner: IPlayer | undefined; arrivedPlayer: IPlayer; toll?: number };
		result: { owner: IPlayer | undefined; arrivedPlayer: IPlayer; toll?: number };
	};
}
