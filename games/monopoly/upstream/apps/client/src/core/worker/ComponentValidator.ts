import {
	Role,
	PropertyInfo,
	GamePhaseInfo,
	ChanceCardInfo,
} from "@mine-monopoly/types";
import { compileTsToJs } from "@src/utils";
import { ComponentValidationError, DetailedErrorData, WorkerCommMsg } from "@src/interfaces/worker";
import { ErrorCategory } from "@src/utils/log";
import { WorkerCommType } from "@src/enums/worker";

export class ComponentValidator {
	private errors: ComponentValidationError[] = [];

	constructor(
		private fullTypes: string,
		private mapInfo: { mapId?: string; mapName?: string; mapVersion?: string }
	) {}

	validateRole(role: Role, userId: string): boolean {
		try {
			const codeCompiled = compileTsToJs(role.initCode, this.fullTypes);
			new Function(codeCompiled)();
			return true;
		} catch (e: any) {
			const error: ComponentValidationError = {
				componentType: 'role',
				componentId: role.id,
				componentName: role.name,
				errorType: 'compile',
				errorMessage: e.message,
				errorStack: e.stack,
				userId
			};
			this.errors.push(error);
			this.logError(error, e);
			return false;
		}
	}

	validateProperty(property: PropertyInfo): boolean {
		if (!property.custom) return true;
		try {
			const codeCompiled = compileTsToJs(property.custom.effectCode, this.fullTypes);
			new Function(codeCompiled)();
			return true;
		} catch (e: any) {
			const error: ComponentValidationError = {
				componentType: 'property',
				componentId: property.id,
				componentName: property.name,
				errorType: 'compile',
				errorMessage: e.message,
				errorStack: e.stack,
			};
			this.errors.push(error);
			this.logError(error, e);
			return false;
		}
	}

	validatePhase(phase: GamePhaseInfo): boolean {
		try {
			const codeCompiled = compileTsToJs(phase.initEventCode, this.fullTypes);
			new Function(codeCompiled)();
			return true;
		} catch (e: any) {
			const error: ComponentValidationError = {
				componentType: 'phase',
				componentId: phase.id || phase.name || "unknown",
				componentName: phase.name || "未命名阶段",
				errorType: 'compile',
				errorMessage: e.message,
				errorStack: e.stack,
			};
			this.errors.push(error);
			this.logError(error, e);
			return false;
		}
	}

	validateChanceCard(card: ChanceCardInfo): boolean {
		try {
			const codeCompiled = compileTsToJs(card.effectCode, this.fullTypes);
			new Function(codeCompiled)();
			return true;
		} catch (e: any) {
			const error: ComponentValidationError = {
				componentType: 'chanceCard',
				componentId: card.id,
				componentName: card.name,
				errorType: 'compile',
				errorMessage: e.message,
				errorStack: e.stack,
			};
			this.errors.push(error);
			this.logError(error, e);
			return false;
		}
	}

	hasErrors(): boolean {
		return this.errors.length > 0;
	}

	getErrors(): ComponentValidationError[] {
		return [...this.errors];
	}

	private logError(error: ComponentValidationError, originalError: Error) {
		const errorData: DetailedErrorData = {
			category: ErrorCategory.COMPONENT_VALIDATION,
			type: error.componentType,
			component: error.componentId,
			message: this.formatUserFriendlyMessage(error),
			technical: {
				message: error.errorMessage,
				stack: error.errorStack,
				mapInfo: this.mapInfo
			}
		};
		self.postMessage(<WorkerCommMsg>{
			type: WorkerCommType.DetailedError,
			data: errorData
		});
	}

	private formatUserFriendlyMessage(error: ComponentValidationError): string {
		switch (error.componentType) {
			case 'role':
				return `角色「${error.componentName}」的代码编译失败，玩家 ${error.userId} 无法加入游戏`;
			case 'property':
				return `地皮「${error.componentName}」的自定义代码编译失败`;
			case 'phase':
				return `游戏阶段「${error.componentName}」的代码编译失败`;
			case 'chanceCard':
				return `机会卡「${error.componentName}」的代码编译失败`;
			default:
				return `未知组件错误: ${error.errorMessage}`;
		}
	}
}
