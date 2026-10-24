import { createVNode, render, shallowReactive, type AppContext, type VNode } from "vue";
import fpMessageVue from "./fp-message.vue";

// 1. 定义配置接口
export interface MessageOptions {
	type?: "info" | "success" | "warning" | "error";
	message: string;
	duration?: number;
	onClosed?: () => void;
	appContext?: AppContext;
	offset?: number;
}

// 2. 定义组件暴露的方法接口 (对应 fp-message.vue 的 defineExpose)
interface MessageInstance {
	id: string;
	vnode: VNode;
	container: HTMLElement;
	props: MessageOptions; // onClosed 在这里面
	setVisible: (visible: boolean) => Promise<string>;
	setTop: (top: number) => void;
}

// 3. 消息队列 (使用 shallowReactive 监听变化)
const messageInstances = shallowReactive<MessageInstance[]>([]);

let seed = 1;

const FPMessage = (options: MessageOptions | string) => {
	const opts = typeof options === "string" ? { message: options } : options;

	const id = `fp_message_${seed++}`;
	const container = document.createElement("div");

	const props = {
		...opts,
		delay: opts.duration || 3000,
		onClose: () => {
			closeMessage(id);
		},
	};

	// 创建 VNode
	const vnode = createVNode(fpMessageVue, props);

	if (opts.appContext) {
		vnode.appContext = opts.appContext;
	}

	// 渲染
	render(vnode, container);
	document.body.appendChild(container.firstElementChild!);
	document.body.appendChild(container);

	const componentExposed = vnode.component?.exposed as unknown as MessageInstance;

	if (!componentExposed) {
		console.warn("FPMessage: Component definition missing defineExpose for setVisible/setTop");
		return;
	}

	const instance: MessageInstance = {
		id,
		vnode,
		container,
		props: opts,
		setVisible: componentExposed.setVisible,
		setTop: componentExposed.setTop,
	};

	messageInstances.push(instance);

	updatePositions();

	instance.setVisible(true);

	const duration = opts.duration || 3000;
	if (duration > 0) {
		setTimeout(() => {
			closeMessage(id);
		}, duration);
	}

	return instance;
};

const closeMessage = async (id: string) => {
	const idx = messageInstances.findIndex((item) => item.id === id);
	if (idx === -1) return;

	const removedItem = messageInstances.splice(idx, 1)[0];

	updatePositions();

	if (removedItem.props.onClosed) {
		removedItem.props.onClosed();
	}

	if (removedItem.setVisible) {
		await removedItem.setVisible(false);
	}

	render(null, removedItem.container);

	if (removedItem.container && removedItem.container.parentNode) {
		removedItem.container.parentNode.removeChild(removedItem.container);
	}
};
const updatePositions = () => {
	messageInstances.forEach((instance, index) => {
		const topRem = index * 4 + 1.2;
		instance.setTop(topRem);
	});
};

// 快捷调用方式
FPMessage.success = (msg: string, opts?: MessageOptions) => FPMessage({ ...opts, message: msg, type: "success" });
FPMessage.warning = (msg: string, opts?: MessageOptions) => FPMessage({ ...opts, message: msg, type: "warning" });
FPMessage.info = (msg: string, opts?: MessageOptions) => FPMessage({ ...opts, message: msg, type: "info" });
FPMessage.error = (msg: string, opts?: MessageOptions) => FPMessage({ ...opts, message: msg, type: "error" });

export default FPMessage;
