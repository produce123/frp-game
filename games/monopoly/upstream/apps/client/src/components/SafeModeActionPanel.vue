<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import useEventBus from "@src/utils/event-bus";
import router from "@src/router";
import { SocketMsgType, SocketMsgSource, OperateType } from "@mine-monopoly/types";
import { useMonopolyClient } from "@src/core/monopoly-client/MonopolyClient";
import { useRoomInfo } from "@src/store";

interface SafeModeData {
	reason: string;
	canSave: boolean;
	errorDetails?: {
		category?: string;
		type?: string;
		message?: string;
		stack?: string;
	};
}

const visible = ref(false);
const safeModeData = ref<SafeModeData>({
	reason: "",
	canSave: false,
	errorDetails: undefined,
});

const roomInfoStore = useRoomInfo();

// 是否是房主
const isRoomOwner = computed(() => roomInfoStore.amIRoomOwner);

/**
 * 处理存档并退出操作
 */
const handleSaveAndExit = () => {
	const client = useMonopolyClient();
	if (!client) return;

	client.sendMsg({
		type: SocketMsgType.Operation,
		source: SocketMsgSource.Client,
		data: {
			operateType: OperateType.SafeModeSaveAndExit,
			data: undefined,
		},
	});
	visible.value = false;
	router.replace({ name: "room" });
};

/**
 * 处理放弃游戏操作
 */
const handleAbort = () => {
	const client = useMonopolyClient();
	if (!client) return;

	client.sendMsg({
		type: SocketMsgType.Operation,
		source: SocketMsgSource.Client,
		data: {
			operateType: OperateType.SafeModeAbort,
			data: undefined,
		},
	});
	visible.value = false;
	router.replace({ name: "room" });
};

/**
 * 处理关闭面板（非房主玩家只能关闭，无法操作）
 */
const handleClose = () => {
	visible.value = false;
	router.replace({ name: "room" });
};

/**
 * 显示安全模式面板
 */
const showSafeModePanel = (data: SafeModeData) => {
	safeModeData.value = data;
	visible.value = true;
};

// 监听路由变化，在 room 和 game 页面注册事件（解决 GameRenderer.destroy 中 removeAll() 清掉监听器的问题）
// room 路由也需要注册，因为游戏初始化失败时用户还在 room 页面，未导航到 game
watch(
	() => router.currentRoute.value.name,
	(name, oldName) => {
		const eventBus = useEventBus();
		const shouldListen = name === "game" || name === "room";
		const wasListening = oldName === "game" || oldName === "room";
		if (shouldListen) {
			eventBus.on("safe-mode:show", showSafeModePanel);
		} else if (wasListening) {
			eventBus.remove("safe-mode:show", showSafeModePanel);
		}
	},
	{ immediate: true },
);
</script>

<template>
	<Teleport to="body">
		<Transition name="fade">
			<div v-if="visible" class="safe-mode-overlay" @click.self="handleClose">
				<div class="safe-mode-panel">
					<!-- 警告图标 -->
					<div class="warning-icon">
						<FontAwesomeIcon icon="fa-circle-exclamation" />
					</div>

					<!-- 标题 -->
					<h2 class="panel-title">进程遇到错误</h2>

					<!-- 原因说明 -->
					<p class="reason-text">{{ safeModeData.reason }}</p>

					<!-- 错误详情 -->
					<div v-if="safeModeData.errorDetails" class="error-details-section">
												<div class="error-details">
								<div v-if="safeModeData.errorDetails.category" class="detail-item">
									<span class="detail-label">错误类别:</span>
									<span class="detail-value">{{ safeModeData.errorDetails.category }}</span>
								</div>
								<div v-if="safeModeData.errorDetails.type" class="detail-item">
									<span class="detail-label">错误类型:</span>
									<span class="detail-value">{{ safeModeData.errorDetails.type }}</span>
								</div>
								<div v-if="safeModeData.errorDetails.message" class="detail-item">
									<span class="detail-label">错误信息:</span>
									<span class="detail-value">{{ safeModeData.errorDetails.message }}</span>
								</div>
								<div v-if="safeModeData.errorDetails.stack" class="detail-item">
									<span class="detail-label">错误堆栈:</span>
									<pre class="detail-stack">{{ safeModeData.errorDetails.stack }}</pre>
								</div>
							</div>
						</div>

					<!-- 操作按钮区域 -->
					<div class="action-buttons">
						<!-- 非房主玩家只能关闭面板 -->
						<template v-if="!isRoomOwner">
							<button class="btn-gray" @click="handleClose">
								关闭
							</button>
							<p class="waiting-text">等待房主处理...</p>
						</template>

						<!-- 房主可以选择存档退出或放弃 -->
						<template v-else>
							<!-- 只有游戏有进度时才显示存档并退出按钮 -->
							<button v-if="safeModeData.canSave" class="btn-green" @click="handleSaveAndExit">
								<FontAwesomeIcon icon="fa-floppy-disk" />
								<span>存档并退出</span>
							</button>
							<button class="btn-red" @click="handleAbort">
								<FontAwesomeIcon :icon="safeModeData.canSave ? 'fa-right-from-bracket' : 'fa-house'" />
								<span>{{ safeModeData.canSave ? '放弃游戏' : '返回房间' }}</span>
							</button>
						</template>
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<style lang="scss" scoped>
.safe-mode-overlay {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background-color: rgba(0, 0, 0, 0.7);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 9999;
	backdrop-filter: blur(0.25rem);
}

.safe-mode-panel {
	position: relative;
	width: 90%;
	max-width: 31.25rem;
	background-color: #ffffff;
	background-image: var(--fp-texture-felt);
	background-repeat: repeat;
	border-radius: 1.5rem;
	padding: 2rem;
	box-shadow:
		0 1.25rem 3.75rem rgba(0, 0, 0, 0.3),
		0 0 0 0.1875rem rgba(0, 0, 0, 0.05);
	text-align: center;
	animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
	from {
		opacity: 0;
		transform: translateY(-1.25rem) scale(0.95);
	}
	to {
		opacity: 1;
		transform: translateY(0) scale(1);
	}
}

.warning-icon {
	font-size: 3rem;
	color: #f59e0b;
	margin-bottom: 1rem;
	animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
	0%, 100% {
		transform: scale(1);
	}
	50% {
		transform: scale(1.1);
	}
}

.panel-title {
	font-size: 1.5rem;
	font-weight: 700;
	color: #1f2937;
	margin: 0 0 1rem 0;
}

.reason-text {
	font-size: 1rem;
	color: #6b7280;
	line-height: 1.6;
	margin: 0 0 1.5rem 0;
}

.error-details-section {
	margin-bottom: 1.5rem;
	text-align: left;
}

.details-toggle {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 0.5rem;
	width: 100%;
	font-size: 0.875rem;
}

.error-details {
	margin-top: 0.75rem;
	padding: 1rem;
	background-color: #fef2f2;
	border: 0.0625rem solid #fecaca;
	border-radius: 0.5rem;
}

.detail-item {
	display: flex;
	flex-direction: column;
	gap: 0.25rem;
	margin-bottom: 0.75rem;

	&:last-child {
		margin-bottom: 0;
	}
}

.detail-label {
	font-size: 0.75rem;
	color: #991b1b;
	text-transform: uppercase;
	letter-spacing: 0.05em;
}

.detail-value {
	font-size: 0.875rem;
	color: #7f1d1d;
	font-family: monospace;
	word-break: break-all;
}

.detail-stack {
	margin: 0.25rem 0 0 0;
	padding: 0.5rem;
	background-color: #fee2e2;
	border-radius: 0.25rem;
	font-size: 0.75rem;
	color: #991b1b;
	font-family: monospace;
	white-space: pre-wrap;
	word-break: break-all;
	line-height: 1.4;
	max-height: 12.5rem;
	overflow-y: auto;
}

.action-buttons {
	display: flex;
	flex-direction: column;
	gap: 0.75rem;
	align-items: center;
}

.waiting-text {
	font-size: 0.875rem;
	color: #6b7280;
	margin: 0.5rem 0 0 0;
	font-style: italic;
}

button {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 0.5rem;
	width: 100%;
	padding: 0.875rem 1.5rem;
	border-radius: 0.75rem;
	font-size: 1rem;
	cursor: pointer;
	transition: all 0.2s;
	border: none;

	&:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
}


/* 过渡动画 */
.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}

.expand-enter-active,
.expand-leave-active {
	transition: all 0.3s ease;
	overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
	max-height: 0;
	opacity: 0;
}

.expand-enter-to,
.expand-leave-from {
	max-height: 12.5rem;
	opacity: 1;
}
</style>
