<script lang="ts" setup>
import { onMounted, ref } from "vue";

const props = defineProps<{
	bgColor: string;
	title?: string;
}>();

const isMaximized = ref(false);

const checkMaximized = async () => {
	isMaximized.value = await window.platformAPI?.isMaximized?.() ?? false;
};

onMounted(() => {
	checkMaximized();
});

const minimizeWindow = () => {
	window.platformAPI?.minimize?.();
};

const toggleMaximize = () => {
	window.platformAPI?.maximize?.();
	checkMaximized();
};

const handleMaximize = () => {
	if (window.innerWidth === screen.width && window.innerHeight === screen.height) {
		window.platformAPI?.unmaximize?.();
	} else {
		window.platformAPI?.maximize?.();
	}
	checkMaximized();
};

const closeWindow = () => {
	window.platformAPI?.close?.();
};
</script>

<template>
	<div class="title-bar" :style="{ backgroundColor: props.bgColor }" @dblclick="handleMaximize">
		<!-- 拖拽区域 -->
		<div class="drag-area">
			<slot name="title"></slot>
		</div>

		<!-- 窗口控制按钮 -->
		<div class="window-controls">
			<button @click="minimizeWindow" class="control-button minimize btn-small">
				<font-awesome-icon style="font-size: 0.8em" :icon="['fas', 'window-minimize']" />
			</button>
			<button @click="toggleMaximize" class="control-button maximize btn-small">
				<font-awesome-icon style="font-size: 0.95em" :icon="['fas', isMaximized ? 'compress' : 'expand']" />
			</button>
			<button @click="closeWindow" class="control-button close btn-small">
				<font-awesome-icon style="font-size: 1.2em" :icon="['fas', 'xmark']" />
			</button>
		</div>
	</div>
</template>

<style lang="scss" scoped>
.title-bar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	height: 30px;
	min-height: 30px;
	color: white;
	user-select: none;
	overflow: hidden;
	-webkit-app-region: drag;
}

.drag-area {
	flex: 1;
	display: flex;
	align-items: center;
	height: 100%;
	-webkit-app-region: drag;
	padding-left: 10px;
	overflow: hidden;
}

.window-controls {
	display: flex;
	height: 100%;
	-webkit-app-region: no-drag;
}

.control-button {
	display: flex;
	justify-content: center;
	align-items: center;
	width: 46px;
	height: 100%;
	border: none;
	background: transparent;
	color: white;
	transition: background-color 0.2s;
	border-radius: 0;
	box-shadow: none;
}

.control-button:hover {
	background-color: rgba(255, 255, 255, 0.1);
	box-shadow: none;
}

.control-button.close:hover {
	background-color: #e81123;
}

.control-button span {
	font-size: 16px;
	line-height: 1;
}
</style>
