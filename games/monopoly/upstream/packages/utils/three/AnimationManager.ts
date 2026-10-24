import * as THREE from "three";

export interface AnimationOptions {
	autoPlay?: boolean;
	loop?: THREE.AnimationActionLoopStyles;
	speed?: number;
}

interface AnimatedModel {
	mixer: THREE.AnimationMixer;
	actions: Map<string, THREE.AnimationAction>;
	object3D: THREE.Object3D;
}

export class AnimationManager {
	private clock: THREE.Clock;
	private animatedModels: Map<string, AnimatedModel>;

	constructor() {
		this.clock = new THREE.Clock();
		this.animatedModels = new Map();
	}

	registerModel(id: string, gltf: any, object3D: THREE.Object3D, options?: AnimationOptions): void {
		if (!gltf.animations || gltf.animations.length === 0) return;

		const mixer = new THREE.AnimationMixer(object3D);
		const actions = new Map<string, THREE.AnimationAction>();

		gltf.animations.forEach((clip: THREE.AnimationClip) => {
			const action = mixer.clipAction(clip);
			const animationName = clip.name || `${id}_${clip.uuid}`;
			actions.set(animationName, action);
			if (options?.loop !== undefined) {
				action.setLoop(options.loop, Infinity);
			}
		});

		this.animatedModels.set(id, { mixer, actions, object3D });

		if (options?.autoPlay && gltf.animations.length > 0) {
			this.playAll(id);
		}
	}

	unregisterModel(id: string): void {
		const model = this.animatedModels.get(id);
		if (model) {
			model.mixer.stopAllAction();
			model.mixer.uncacheRoot(model.object3D);
			this.animatedModels.delete(id);
		}
	}

	play(id: string, animationName?: string): void {
		const model = this.animatedModels.get(id);
		if (!model) return;

		if (animationName) {
			const action = model.actions.get(animationName);
			if (action) action.reset().play();
		} else {
			const firstAction = model.actions.values().next().value;
			if (firstAction) firstAction.reset().play();
		}
	}

	playAll(id: string): void {
		const model = this.animatedModels.get(id);
		if (!model) return;

		model.actions.forEach((action) => {
			action.reset().play();
		});
	}

	pause(id: string): void {
		const model = this.animatedModels.get(id);
		if (!model) return;
		model.mixer.timeScale = 0;
	}

	resume(id: string): void {
		const model = this.animatedModels.get(id);
		if (!model) return;
		model.mixer.timeScale = 1;
	}

	stop(id: string): void {
		const model = this.animatedModels.get(id);
		if (!model) return;
		model.mixer.stopAllAction();
	}

	update(delta?: number): void {
		const dt = delta ?? this.clock.getDelta();
		this.animatedModels.forEach((model) => {
			model.mixer.update(dt);
		});
	}

	dispose(): void {
		this.animatedModels.forEach((model) => {
			model.mixer.stopAllAction();
			model.mixer.uncacheRoot(model.object3D);
		});
		this.animatedModels.clear();
	}

	hasAnimation(id: string): boolean {
		return this.animatedModels.has(id);
	}

	getAnimationNames(id: string): string[] {
		const model = this.animatedModels.get(id);
		return model ? Array.from(model.actions.keys()) : [];
	}
}
