<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, nextTick } from "vue";
import StatCard from "./stat-card.vue";
import { getUserStatistics, type UserStatistics } from "@/utils/api/statistics";

const stats = ref<UserStatistics | null>(null);
const chartLoading = ref(true);
let chartInstance: any = null;
let ChartClass: any = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const chartContainerId = "user-trend-chart";

async function loadChartLib() {
	if (!ChartClass) {
		const g2 = await import("@antv/g2");
		ChartClass = g2.Chart;
	}
}

async function refresh() {
	try {
		const [data] = await Promise.all([getUserStatistics(), loadChartLib()]);
		stats.value = data;
		await nextTick();
		await renderChart();
	} catch {
		// 静默处理，下次刷新重试
	}
	refreshTimer = setTimeout(refresh, 30000);
}

async function renderChart() {
	if (!stats.value?.trend || !ChartClass) return;

	const container = document.getElementById(chartContainerId);
	if (!container) return;

	if (chartInstance) {
		chartInstance.changeData(stats.value.trend);
		return;
	}

	chartInstance = new ChartClass({
		container,
		autoFit: true,
		height: 200,
		padding: [20, 30, 30, 50],
		animate: false,
	});

	chartInstance
		.line()
		.data(stats.value.trend)
		.encode("x", "date")
		.encode("y", "count")
		.style("stroke", "#1890ff")
		.style("lineWidth", 2);

	chartInstance
		.point()
		.data(stats.value.trend)
		.encode("x", "date")
		.encode("y", "count")
		.style("fill", "#1890ff")
		.style("r", 3);

	chartInstance.axis("x", {
		title: false,
		labelFormatter: (d: string) => {
			const parts = d.split("-");
			return `${Number(parts[1])}/${Number(parts[2])}`;
		},
	});
	chartInstance.axis("y", { title: false });

	await chartInstance.render();
	chartLoading.value = false;
}

onMounted(() => {
	refresh();
});

onBeforeUnmount(() => {
	if (refreshTimer) clearTimeout(refreshTimer);
	if (chartInstance) chartInstance.destroy();
});
</script>

<template>
	<div class="user-stats">
		<a-row :gutter="[12, 12]" v-if="stats">
			<a-col :xs="8" :sm="8">
				<StatCard title="总用户" :value="stats.totalUsers" icon="fa-solid fa-users" />
			</a-col>
			<a-col :xs="8" :sm="8">
				<StatCard title="在线用户" :value="stats.onlineUsers" icon="fa-solid fa-circle-dot" />
			</a-col>
			<a-col :xs="8" :sm="8">
				<StatCard title="管理员" :value="stats.adminUsers" icon="fa-solid fa-user-shield" />
			</a-col>
		</a-row>
		<a-card :bordered="false" class="chart-card">
			<h4>7天注册趋势</h4>
			<div :id="chartContainerId" class="chart-container"></div>
			<div v-if="chartLoading" class="chart-loading">
				<a-spin size="small" />
			</div>
		</a-card>
	</div>
</template>

<style lang="scss" scoped>
.user-stats {
	margin-bottom: 16px;
}

.chart-card {
	margin-top: 12px;
	position: relative;

	h4 {
		margin: 0 0 8px;
		font-size: 14px;
		color: #666;
	}
}

.chart-container {
	width: 100%;
	min-height: 200px;
}

.chart-loading {
	position: absolute;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -50%);
}
</style>
