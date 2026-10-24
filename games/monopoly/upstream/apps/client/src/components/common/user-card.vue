<script setup lang="ts">
import { computed } from "vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { adjustColorAuto, adjustColorBrightness, lightenColor } from "@src/utils";
import { __PROTOCOL__ } from "@src/../global.config";

const props = defineProps<{ username: string; color: string; avatar: string }>();

const avatarSrc = computed(() => {
	return props.avatar || "";
});
</script>

<template>
	<div class="user-card">
		<div class="avatar">
			<img v-if="avatarSrc" :src="avatarSrc" />
			<FontAwesomeIcon v-else :style="{ color: color }" icon="gamepad" />
		</div>
		<div class="info">
			<p class="username">{{ username }}</p>
		</div>
	</div>
</template>

<style lang="scss" scoped>
@use "@src/assets/variables" as *;
@use "@mine-monopoly/style/variables" as fp;

.user-card {
	width: 100%;
	height: 100%;
	display: flex;
	justify-content: space-around;
	align-items: center;
	box-sizing: border-box;
	@include felt-patch(#ffedb7);
	padding: 1.5rem;
	border-radius: 1.8rem;

	& > .avatar {
		// @include felt-patch(#ffffff);
		$icon-size: 5rem;
		width: $icon-size;
		height: $icon-size;
		min-width: $icon-size;
		min-height: $icon-size;
		line-height: $icon-size;
		text-align: center;
		background-color: rgba(255, 255, 255, 0.5);
		border: 0.3rem solid #ffffff;
		border-radius: 50%;
		font-size: 2.5rem;
		color: #ffffff;
		overflow: hidden;
		display: flex;
		justify-content: center;
		align-items: center;
		box-shadow:
			0 0.25rem 0 rgba(0, 0, 0, 0.15),
			0 0 0 0.1875rem rgba(0, 0, 0, 0.05);

		& > img {
			width: calc($icon-size - 0.5rem);
			height: calc($icon-size - 0.5rem);
			border-radius: 50%;
			display: block;
		}
	}

	& > .info {
		flex: 1;
		display: flex;
		justify-content: space-around;
		align-items: center;
		flex-direction: column;

		& > .username {
			color: #ffffff;
			font-size: 2em;
			text-shadow: var(--fp-text-shadow);
			word-break: break-all;
		}
	}
}
</style>
