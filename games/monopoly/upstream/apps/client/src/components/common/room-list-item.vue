<script setup lang="ts">
const props = defineProps({
	ownerName: {
		type: String,
		defaul: "",
	},
	playerNum: {
		type: Number,
		defaul: 0,
	},
});
</script>

<template>
	<div class="room-router-item">
		<div class="room-info-container">
			<div class="room-name">
				<span>{{ ownerName }}</span
				><span>的房间</span>
			</div>
		</div>
		<div class="player-num-contianer">
			<span>{{ playerNum }}</span
			><span>/6</span>
		</div>
	</div>
</template>

<style lang="scss" scoped>
.room-router-item {
	height: 6.25rem;
	margin: 0.625rem;
	border-radius: 0.625rem;
	box-sizing: border-box;
	display: flex;
	justify-content: space-between;
	align-items: center;
	background-color: #ffffff;
	box-shadow: 0.0625rem 0.0625rem 0.2rem rgba(0, 0, 0, 0.1);
	overflow: hidden;
	cursor: pointer;
	transition: 0.1s;

	&:hover {
		transform: scale(1.005, 1.005);
		box-shadow: 0.13rem 0.13rem 0.2rem rgba(0, 0, 0, 0.15);
	}

	& > .room-info-container {
		height: 100%;
		padding: 1.5625rem;
		font-size: 1.6em;
		display: flex;
		align-items: center;

		& > .room-name {
			span:nth-child(1) {
				color: #f75830;
			}

			span:nth-child(2) {
				color: #af3c3c;
			}
		}
	}

	& > .player-num-contianer {
		height: 100%;
		font-size: 1.5em;
		padding: 0.625rem 1.25rem 0.625rem 2.5rem;
		background-color: #ffe02d;
		display: flex;
		align-items: center;
		-webkit-clip-path: polygon(25% 0, 100% 0, 100% 100%, 0% 100%);
		clip-path: polygon(25% 0, 100% 0, 100% 100%, 0% 100%);
		color: #af3c3c;

		span:nth-child(1) {
			color: #f75830;
		}
	}
}
</style>
