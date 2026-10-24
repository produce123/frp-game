<script setup lang="ts">
import Loading from "@src/components/utils/fp-loading/fp-loading.vue";
import Background from "@src/views/background/background.vue";
import StatusBar from "@src/views/status_bar/status_bar.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { pageEnter, pageLeave } from "@src/utils/gsap/page-transition";
import Chat from "@src/views/chat_log/chat_log.vue";
import DanmakuContainer from "@src/views/danmaku/danmaku_container.vue";
import { isMobileDevice, requestLandscapeFullscreen } from "@src/utils";
import { TitleBar } from "@mine-monopoly/ui";
import SafeModeActionPanel from "@src/components/SafeModeActionPanel.vue";
import { getPlatformType, isPC } from "./utils/platform";
import { useDeviceStatus } from "./store";
import {
	faBolt,
	faBomb,
	faBook,
	faBookTanakh,
	faBug,
	faCircleUser,
	faCode,
	faCompress,
	faCopy,
	faCrown,
	faGamepad,
	faGear,
	faHeart,
	faHouse,
	faPalette,
	faPersonRunning,
	faQuestion,
	faSackDollar,
	faShuffle,
	faSquareCheck,
	faVolumeHigh,
	faVolumeLow,
	faWandMagicSparkles,
	faWandSparkles,
} from "@fortawesome/free-solid-svg-icons";
import { icon } from "@fortawesome/fontawesome-svg-core";
import Update from "./components/common/update.vue";

const router = useRoute();
const isInGame = computed(() => router.name === "game");
const canChat = computed(() => router.name === "room" || router.name === "game");
const version = __APP_VERSION__;
const deviceStatusStore = useDeviceStatus();
const isTitleBarShow = computed(() => isPC() && !deviceStatusStore.isFullScreen);
const isMobileWeb = getPlatformType() === "mobile";
const showLandscapeGate = ref(isMobileWeb);
const landscapeGateState = ref<"idle" | "requesting" | "retry">("idle");
const landscapeGateError = ref("");
const isLandscapeViewport = computed(() => deviceStatusStore.isLandscape);
const landscapeGateTitle = computed(() => {
	if (landscapeGateState.value === "requesting") {
		return "正在进入横屏模式...";
	}
	if (isLandscapeViewport.value) {
		return "已切换到横屏";
	}
	return "请先进入横屏模式";
});
const landscapeGateDescription = computed(() => {
	if (landscapeGateState.value === "requesting") {
		return "正在请求全屏并锁定为横屏，请稍候。";
	}
	if (isLandscapeViewport.value) {
		return "如果浏览器没有自动锁定方向，可以继续进入游戏。";
	}
	return landscapeGateError.value || "点击按钮后会尝试进入全屏，并将页面锁定为横屏。";
});
const landscapeGateButtonLabel = computed(() => {
	if (landscapeGateState.value === "requesting") {
		return "正在处理中...";
	}
	if (isLandscapeViewport.value) {
		return "继续进入";
	}
	return landscapeGateState.value === "retry" ? "重试横屏" : "进入横屏模式";
});

const fullScreenWatcherStopHandler = watch(
	() => deviceStatusStore.isFullScreen,
	() => {
		nextTick(resizeContainer);
	},
);

const landscapeWatcherStopHandler = watch(
	() => isLandscapeViewport.value,
	(isLandscape) => {
		if (!isMobileWeb) {
			return;
		}

		if (isLandscape) {
			landscapeGateError.value = "";
			nextTick(resizeContainer);
		} else {
			showLandscapeGate.value = true;
		}
	},
);

onMounted(() => {
	window.addEventListener("resize", resizeContainer);
	resizeContainer();
});

onBeforeUnmount(() => {
	window.removeEventListener("resize", resizeContainer);
	fullScreenWatcherStopHandler();
	landscapeWatcherStopHandler();
});

async function handleLandscapeGateConfirm() {
	if (!showLandscapeGate.value || landscapeGateState.value === "requesting") {
		return;
	}

	landscapeGateState.value = "requesting";
	landscapeGateError.value = "";

	const result = await requestLandscapeFullscreen();

	if (result.isLandscape) {
		showLandscapeGate.value = false;
		landscapeGateState.value = "idle";
		nextTick(resizeContainer);
		return;
	}

	landscapeGateState.value = "retry";
	landscapeGateError.value = result.orientationLocked
		? "已请求横屏，请将设备旋转为横向后再继续。"
		: "当前浏览器未能自动锁定横屏，请先手动旋转设备，再点击重试。";
}

function resizeContainer() {
	const topBarHeight = 30;
	const availableHeight = window.innerHeight - (deviceStatusStore.isFullScreen || !isPC() ? 0 : topBarHeight);
	const availableWidth = window.innerWidth;
	const ratio = 16 / 10;
	const fontSizeBase = 0.0115;
	const setRootFontSize = (fontSize: number) => {
		const mobilePortraitMinFontSize = getPlatformType() === "mobile" && availableHeight > availableWidth ? 12 : 0;
		document.documentElement.style.fontSize = `${Math.max(fontSize, mobilePortraitMinFontSize)}px`;
	};

	const container = document.querySelector(".main-container") as HTMLElement;

	// 手机横屏：使用 16:12（4:3）比例，font-size 取宽度/高度计算的中间值
	if (isMobileDevice() && availableWidth / availableHeight > ratio) {
		const mobileRatio = 16 / 9;
		const containerStyle = {
			height: `${availableHeight}px`,
			width: `${availableHeight * mobileRatio}px`,
		};
		Object.assign(container.style, containerStyle);
		container.setAttribute("out-of-width", "");
		container.removeAttribute("out-of-height");
		// 取宽度基准和高度基准的中间值，比纯宽度小但比纯高度大
		const fontSizeByWidth = availableWidth * fontSizeBase;
		const fontSizeByHeight = availableHeight * fontSizeBase * ratio;
		setRootFontSize((fontSizeByWidth + fontSizeByHeight) / 2);
	} else if (availableWidth / availableHeight > ratio) {
		const containerStyle = {
			height: `${availableHeight}px`,
			width: `${availableHeight * ratio}px`,
		};
		Object.assign(container.style, containerStyle);
		container.setAttribute("out-of-width", "");
		container.removeAttribute("out-of-height");
		setRootFontSize(availableHeight * fontSizeBase * ratio);
	} else if (availableWidth / availableHeight < ratio) {
		const containerStyle = {
			height: `${availableWidth / ratio}px`,
			width: `${availableWidth}px`,
		};
		Object.assign(container.style, containerStyle);
		container.setAttribute("out-of-height", "");
		container.removeAttribute("out-of-width");
		setRootFontSize(availableWidth * fontSizeBase);
	} else {
		const containerStyle = {
			height: `${availableWidth / ratio}px`,
			width: `${availableWidth}px`,
		};
		Object.assign(container.style, containerStyle);
		container.removeAttribute("out-of-height");
		container.removeAttribute("out-of-width");
		setRootFontSize(availableWidth * fontSizeBase);
	}
}

const backgroundSvgList: string[] = [
	faBolt,
	faBomb,
	faHeart,
	faHouse,
	faPalette,
	faSackDollar,
	faWandMagicSparkles,
	faBug,
	faCode,
	faCircleUser,
	faGamepad,
	faCopy,
	faBookTanakh,
	faCompress,
	faCrown,
	faPersonRunning,
	faWandSparkles,
	faGear,
	faSquareCheck,
	faVolumeLow,
	faVolumeHigh,
	faQuestion,
	faBook,
	faShuffle,
].map((i) => {
	return icon(i).html[0];
});
</script>

<template>
	<TitleBar style="z-index: var(--z-topbar)" v-if="isTitleBarShow" :bg-color="'#f38b11'">
		<template #title>
			<span style="font-size: 0.75rem">Mine Monopoly v{{ version }}</span>
		</template>
	</TitleBar>
	<div v-if="showLandscapeGate" class="landscape-gate">
		<div class="landscape-gate__panel">
			<div class="landscape-gate__badge">
				<font-awesome-icon icon="expand" />
				<font-awesome-icon icon="rotate" />
			</div>
			<h1 class="landscape-gate__title">{{ landscapeGateTitle }}</h1>
			<p class="landscape-gate__description">{{ landscapeGateDescription }}</p>
			<button
				class="landscape-gate__button btn-small"
				:disabled="landscapeGateState === 'requesting'"
				@click="handleLandscapeGateConfirm"
			>
				{{ landscapeGateButtonLabel }}
			</button>
			<p class="landscape-gate__tips">建议关闭屏幕方向锁定后再尝试，Android 浏览器成功率更高。</p>
		</div>
	</div>
	<div class="main-container-wrapper">
		<div class="main-container" id="fpmessage-container">
			<template v-if="!showLandscapeGate">
				<Chat v-if="canChat" />
				<DanmakuContainer v-if="canChat" />
				<Background
					background-color="var(--fp-color-tertiary)"
					color="var(--fp-color-secondary)"
					:icons="backgroundSvgList"
					:icon-size="70"
					:angle="40"
					:speed="60"
					:gap="80"
					:opacity-range="[0.5, 0.5]"
					:scale-range="[1, 1]"
					v-if="!isInGame"
				/>
				<Loading />
				<StatusBar />
				<!-- <MusicPlayer v-if="isMusicPlayerVisiable" /> -->
				<RouterView v-slot="{ Component, route }">
					<Transition :css="false" mode="out-in" @enter="pageEnter" @leave="pageLeave" appear>
						<component :is="Component" :key="route.path" />
					</Transition>
				</RouterView>
			</template>
		</div>
	</div>
	<Update v-if="!showLandscapeGate" />
	<SafeModeActionPanel v-if="!showLandscapeGate" />
</template>

<style lang="scss" scoped>
@use "./assets/variables" as *;

.main-container-wrapper {
	flex: 1;
	display: flex;
	justify-content: center;
	align-items: center;
}
.main-container {
	position: relative;
	display: flex;
	justify-content: center;
	align-items: center;
	width: 100%;
	height: 100%;
	// overflow: hidden;

	$border-width: 0.6rem;
	$border-offset: -0.4rem;

	@mixin transitional-border-base {
		content: "";
		position: absolute;
		border: solid color-mix(in srgb, var(--fp-color-tertiary) 95%, #000000);
		pointer-events: none;
	}

	&[out-of-width]::after {
		@include transitional-border-base;
		border-width: 0 $border-width;
		left: $border-offset;
		top: 0;
		right: $border-offset;
		bottom: 0;
	}

	&[out-of-height]::after {
		@include transitional-border-base;
		border-width: $border-width 0;
		left: 0;
		top: $border-offset;
		right: 0;
		bottom: $border-offset;
	}
	// width: 100%;
	// height: auto;
	// aspect-ratio: $ratio;
	// margin: 0 auto;

	// /* 视口比较宽时，以高度为准 */
	// @media (min-aspect-ratio: $ratio) {
	// 	width: auto;
	// 	height: 100%;
	// }
}

.landscape-gate {
	position: fixed;
	inset: 0;
	z-index: calc(var(--z-topbar) + 100);
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 1.5rem;
	background-color: var(--fp-color-tertiary);
	background-image: var(--fp-texture-felt);
}

.landscape-gate__panel {
	@include felt-patch(var(--fp-color-bg-light));

	width: min(34rem, 100%);
	display: flex;
	flex-direction: column;
	align-items: center;
	text-align: center;
	gap: 1rem;
	padding: 1.8rem 1.6rem;
	border-radius: 1rem;
	box-shadow: var(--fp-shadow-depth);
	color: var(--fp-color-text-primary);
	text-shadow: 0 0.0625rem 0 rgba(255, 255, 255, 0.8);
}

.landscape-gate__badge {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 0.8rem;
	width: 4.6rem;
	height: 4.6rem;
	border-radius: 1rem;
	font-size: 1.45rem;
	color: var(--fp-color-text-white);
	background-color: var(--fp-color-secondary);
	background-image: var(--fp-texture-felt);
	border: 0.18rem dashed rgba(255, 255, 255, 0.55);
	box-shadow: var(--fp-shadow-depth);
	text-shadow: var(--fp-text-shadow-pressed);
}

.landscape-gate__title {
	margin: 0;
	font-size: 1.8rem;
	line-height: 1.2;
}

.landscape-gate__description {
	margin: 0;
	font-size: 1rem;
	line-height: 1.6;
}

.landscape-gate__button {
	--btn-bg: var(--fp-color-secondary);

	min-width: 12rem;
	height: 3rem;
	padding: 0 1.4rem;
	border-radius: 0.7rem;
	font-size: 1rem;

	&:disabled {
		opacity: 0.7;
		cursor: wait;
	}
}

.landscape-gate__tips {
	margin: 0;
	font-size: 0.85rem;
	line-height: 1.5;
	color: var(--fp-color-text-secondary);
}

@media (orientation: portrait) and (max-width: 768px) {
	.landscape-gate {
		align-items: center;
		padding: 16px;
	}

	.landscape-gate__panel {
		width: min(520px, 100%);
		justify-content: flex-start;
		gap: 24px;
		padding: 32px 24px;
		border-radius: 16px;
	}

	.landscape-gate__badge {
		width: 96px;
		height: 96px;
		gap: 16px;
		border-radius: 18px;
		font-size: 32px;
	}

	.landscape-gate__title {
		font-size: 32px;
	}

	.landscape-gate__description {
		font-size: 18px;
	}

	.landscape-gate__button {
		width: min(280px, 100%);
		height: 56px;
		font-size: 18px;
	}

	.landscape-gate__tips {
		font-size: 15px;
	}
}
</style>
