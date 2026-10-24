import { createVNode, render, type AppContext, type VNode, getCurrentInstance } from "vue";
import FPMessageCardVue from "./fp-message-card.vue";
import { UISchema } from "@mine-monopoly/types";

export interface MessageCardOptions {
	title?: string;
	content?: string | VNode | (() => VNode) | UISchema;
	appContext?: AppContext;
	duration?: number;
	onClosed?: () => void;
}

export interface MessageCardHandle {
	close: () => void;
}

export function FPMessageCard(options: MessageCardOptions): MessageCardHandle {
	const container = document.createElement("div");

	let contentNode = options.content;
	if (typeof contentNode === "function") {
		contentNode = contentNode();
	}

	const vnode = createVNode(FPMessageCardVue, {
		...options,
		content: contentNode,
		onClosed: () => {
			render(null, container);
			container.remove();
			if (options.onClosed) {
				options.onClosed();
			}
		},
	});

	if (options.appContext) {
		vnode.appContext = options.appContext;
	} else {
		const current = getCurrentInstance();
		if (current) vnode.appContext = current.appContext;
	}

	render(vnode, container);

	if (vnode.component && vnode.component.exposed) {
		(vnode.component.exposed as any).open();

		// 返回关闭方法
		return {
			close: () => {
				(vnode.component!.exposed as any).close();
			},
		};
	}

	// 如果没有 exposed，返回一个空的 close 方法
	return {
		close: () => {
			render(null, container);
			container.remove();
		},
	};
}
