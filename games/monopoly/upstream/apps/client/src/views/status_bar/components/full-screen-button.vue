<script setup lang="ts">
import { useDeviceStatus } from "@src/store";
import { exitFullScreen, requestFullScreen, requestLandscapeFullscreen } from "@src/utils";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed } from "vue";
import { getPlatformType } from "@src/utils/platform";

const deviceStatusStore = useDeviceStatus();
const isFullScreen = computed(() => deviceStatusStore.isFullScreen);

function handleFullScreen() {
	if (isFullScreen.value) {
		exitFullScreen();
		return;
	}

	if (getPlatformType() === "mobile") {
		requestLandscapeFullscreen();
		return;
	}

	requestFullScreen();
}
</script>

<template>
	<button @click="handleFullScreen" class="full-screen-button btn-small">
		<span>{{ isFullScreen ? "退出全屏" : "全屏" }}</span>
		<FontAwesomeIcon :icon="isFullScreen ? 'compress' : 'expand'" />
	</button>
</template>

<style lang="scss" scoped>
.full-screen-button {
	height: 2.5rem;
	border-radius: 0.5rem;
	font-size: 1.1rem;
	display: flex;
	justify-content: center;
	align-items: center;
	gap: 0.4rem;
}
</style>
