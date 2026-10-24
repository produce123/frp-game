import {
	ICommandBus,
	IGameProcess,
	IModifierManager,
	IPlayer,
	IProperty,
	PropertyCommandMap,
	PropertyCustom,
	PropertyInfo,
} from "@mine-monopoly/types";
import { ModifierManager } from "./action-system/ModifiersManager";
import type { PropertySnapshot } from "@src/core/save/types";
import { CommandBus } from "./action-system/CommandBus";
import { pickSerializableFields } from "../utils/serialize";
import GameProcessTypes from "../editor-lib.d.ts?raw";
import { compileTsToJs } from "@src/utils";

export class Property implements IProperty {
	public id: string;
	public name: string;
	public level: number;
	public maxLevel: number;
	public buildCost: number;
	public sellCost: number;
	public costList: number[];
	public buildingModelIdList: string[] | undefined;
	public custom: PropertyCustom | undefined;
	public owner: IPlayer | undefined = undefined;
	public customUI: string | undefined;

	public modifierManager: IModifierManager<PropertyCommandMap>;
	public commandBus: ICommandBus<PropertyCommandMap>;
	private originalData: PropertyInfo;

	private customPropertyInitFunction: ((property: IProperty, gameProcess: IGameProcess) => void) | undefined;

	constructor(property: PropertyInfo, extraLibs?: string) {
		this.id = property.id;
		this.name = property.name;
		this.level = 0;
		this.buildCost = property.buildCost;
		this.sellCost = property.sellCost;
		this.costList = property.costList;
		this.maxLevel = property.maxLevel;
		this.buildingModelIdList = property.buildingModelIdList;
		this.custom = property.custom;
		this.originalData = property;
		this.customUI = property.customUI;

		// 将地图编辑器中定义的扩展字段（如 company）合并到实例
		const propExportData = (property as any).exportData;
		if (propExportData) {
			for (const [key, value] of Object.entries(propExportData)) {
				(this as any)[key] = value;
			}
		}

		this.modifierManager = new ModifierManager();
		(this.modifierManager as any).setOwner(this);
		this.commandBus = new CommandBus<PropertyCommandMap>(this.modifierManager);

		this.initCommandBus();

		if (property.custom) {
			const fullTypes = extraLibs ? `${GameProcessTypes}\n${extraLibs}` : GameProcessTypes;
			try {
				const codeCompiled = compileTsToJs(property.custom.effectCode, fullTypes);
				this.customPropertyInitFunction = new Function(codeCompiled)();
			} catch (e: any) {
				const error = new Error(`地皮自定义代码编译失败 (${property.name}): ${e.message}`);
				error.stack = e.stack;
				throw error;
			}
		}
	}

	public getCustomInitFunction() {
		return this.customPropertyInitFunction;
	}

	private initCommandBus() {
		this.commandBus.setHandler("property.owner.change", async(payload) => {
			const { oldOwner, newOwner } = payload;
			//如果原本有主人
			if (oldOwner) {
				await oldOwner.loseProperty(this);
			}
			this.owner = newOwner;
			if (newOwner) {
				await newOwner.gainProperty(this);
			}
			return payload;
		});

		this.commandBus.setHandler("property.level.up", (payload) => {
			if (this.level < this.maxLevel) {
				this.level++;
			}
			return payload;
		});

		this.commandBus.setHandler("property.level.down", (payload) => {
			if (this.level > 0) {
				this.level--;
			}
			return payload;
		});

		this.commandBus.setHandler("property.level.set", (payload) => {
			const { oldLevel, newLevel } = payload;
			this.level = newLevel;
			return payload;
		});
	}

	public getOriginalData = () => this.originalData;

	public async levelUp() {
		await this.commandBus.execute({ type: "property.level.up", payload: {} });
	}

	public async levelDown() {
		await this.commandBus.execute({ type: "property.level.down", payload: {} });
	}

	public async setLevel(level: number) {
		await this.commandBus.execute({ type: "property.level.set", payload: { oldLevel: this.level, newLevel: level } });
	}

	public async setOwner(player: IPlayer | undefined) {
		await this.commandBus.execute({
			type: "property.owner.change",
			payload: { oldOwner: this.owner, newOwner: player },
		});
	}

	public async arrived(player: IPlayer) {
		await this.commandBus.execute({
			type: "property.arrived",
			payload: { owner: this.owner, arrivedPlayer: player, toll: this.costList[this.level] || 0 },
		});
	}

	public getPropertyInfo(): PropertyInfo & Record<string, any> {
		const owner = this.owner;
		const excludeKeys = new Set([
			"modifierManager", "commandBus", "originalData",
			"id", "name", "level", "maxLevel", "buildCost", "sellCost",
			"costList", "owner", "buildingModelIdList", "custom", "customUI",
			"exportData",
		]);

		const propertyInfo: PropertyInfo & Record<string, any> = {
			id: this.id,
			name: this.name,
			level: this.level,
			maxLevel: this.maxLevel,
			buildCost: this.buildCost,
			sellCost: this.sellCost,
			costList: this.costList,
			owner: owner ? owner.getUser() : undefined,
			buildingModelIdList: this.buildingModelIdList,
			custom: this.custom ? { effectCode: "", description: this.custom.description } : undefined,
			customUI: this.customUI,
			...pickSerializableFields(this, excludeKeys),
		};

		return propertyInfo;
	}

	private static readonly SNAPSHOT_EXCLUDE_KEYS = new Set([
		"modifierManager", "commandBus", "originalData",
		"customPropertyInitFunction", "owner",
		"exportData",
	]);

	private collectSerializableFields(): Record<string, any> {
		return pickSerializableFields(this, Property.SNAPSHOT_EXCLUDE_KEYS, { deep: true });
	}

	public getSnapshot(): PropertySnapshot {
		return {
			...this.collectSerializableFields(),
			level: this.level,
			ownerId: this.owner?.id,
			modifiers: this.modifierManager.getSerializableModifiers(),
		};
	}

	public async restoreFromSnapshot(
		snapshot: PropertySnapshot,
		players: Map<string, any>,
		gameProcess: any,
	): Promise<void> {
		// 通用恢复：遍历快照中所有字段，跳过由专门逻辑处理的
		const specialKeys = new Set(["level", "ownerId", "modifiers", "exportData"]);
		for (const key of Object.keys(snapshot)) {
			if (specialKeys.has(key)) continue;
			if (typeof (this as any)[key] === "function") continue;
			try {
				(this as any)[key] = (snapshot as any)[key];
			} catch {
				// 只读属性等跳过
			}
		}

		// 兼容旧存档格式：将 exportData 桶展开为实例直接属性
		const legacyExportData = (snapshot as any).exportData;
		if (legacyExportData && typeof legacyExportData === "object") {
			for (const [key, value] of Object.entries(legacyExportData)) {
				if (typeof (this as any)[key] === "function") continue;
				try { (this as any)[key] = value; } catch { /* skip */ }
			}
		}

		await this.setLevel(snapshot.level);
		if (snapshot.ownerId) {
			const owner = players.get(snapshot.ownerId);
			await this.setOwner(owner);
		} else {
			await this.setOwner(undefined);
		}

		// 修饰器恢复 — 新签名: restoreModifiers(snaps, mapData)
		(this.modifierManager as any).restoreModifiers(snapshot.modifiers, gameProcess?.mapData);
	}
}
