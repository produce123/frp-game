<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import FpDialog from "@src/components/utils/fp-dialog/fp-dialog.vue";
import { FPMessageBox } from "@src/components/utils/fp-message-box";
import FpMessage from "@mine-monopoly/ui/fp-message";
import logService, {
	type LogErrorData,
	type LogFilter,
	ErrorLevel,
	ErrorCategory,
	LogExportFormat,
} from "@src/utils/log";

/**
 * Props
 */
const props = withDefaults(
	defineProps<{
		visible?: boolean;
	}>(),
	{
		visible: false,
	},
);

/**
 * Emits
 */
const emits = defineEmits<{
	"update:visible": [value: boolean];
}>();

/**
 * 日志数据
 */
const logs = ref<LogErrorData[]>([]);
const loading = ref(false);

/**
 * 筛选条件
 */
const filterLevel = ref<ErrorLevel | "">("");
const filterCategory = ref<ErrorCategory | "">("");
const filterKeyword = ref("");

/**
 * 筛选后的日志
 */
const filteredLogs = computed(() => {
	const filter: LogFilter = {};

	if (filterLevel.value) {
		filter.levels = [filterLevel.value];
	}
	if (filterCategory.value) {
		filter.categories = [filterCategory.value];
	}
	if (filterKeyword.value) {
		filter.keyword = filterKeyword.value;
	}

	// 由于 getLogs 是异步的，这里先使用客户端过滤
	let result = logs.value;

	if (filter.levels) {
		result = result.filter((log) => filter.levels!.includes(log.level));
	}
	if (filter.categories) {
		result = result.filter((log) => filter.categories!.includes(log.category));
	}
	if (filter.keyword) {
		const keyword = filter.keyword.toLowerCase();
		result = result.filter((log) => {
			const searchText = `${log.message} ${log.stack || ""} ${log.info || ""} ${JSON.stringify(log.context)}`.toLowerCase();
			return searchText.includes(keyword);
		});
	}

	return result;
});

/**
 * 日志统计
 */
const logStats = computed(() => {
	const stats = {
		total: logs.value.length,
		fatal: 0,
		error: 0,
		warning: 0,
		info: 0,
	};

	for (const log of logs.value) {
		switch (log.level) {
			case ErrorLevel.FATAL:
				stats.fatal++;
				break;
			case ErrorLevel.ERROR:
				stats.error++;
				break;
			case ErrorLevel.WARNING:
				stats.warning++;
				break;
			case ErrorLevel.INFO:
				stats.info++;
				break;
		}
	}

	return stats;
});

/**
 * 加载日志
 */
async function loadLogs() {
	loading.value = true;
	try {
		logs.value = await logService.getLogs();
	} catch (error) {
		console.error("加载日志失败:", error);
	} finally {
		loading.value = false;
	}
}

/**
 * 刷新日志
 */
async function refreshLogs() {
	await loadLogs();
}

/**
 * 清空日志
 */
async function clearLogs() {
	try {
		await FPMessageBox({
			title: "确认操作",
			content: "确定要清空所有日志吗？",
			confirmText: "确定",
			cancelText: "取消",
			showCancel: true,
		});
	} catch {
		// 用户取消
		return;
	}

	try {
		await logService.clear();
		logs.value = [];
		FpMessage({ type: "success", message: "日志已清空" });
	} catch (error) {
		console.error("清空日志失败:", error);
		FpMessage({ type: "error", message: "清空日志失败" });
	}
}

/**
 * 导出日志
 */
async function exportLogs(format: LogExportFormat) {
	try {
		const blob = await logService.export(format);
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `logs_${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		FpMessage({ type: "success", message: "日志已导出" });
	} catch (error) {
		console.error("导出日志失败:", error);
		FpMessage({ type: "error", message: "导出日志失败" });
	}
}

/**
 * 复制单条日志（包含完整信息）
 */
function copyLog(log: LogErrorData) {
	let text = `[${log.level.toUpperCase()}] ${log.category}\n`;
	text += `消息: ${log.message}\n`;
	if (log.type) text += `类型: ${log.type}\n`;
	if (log.info) text += `附加信息: ${log.info}\n`;
	if (log.stack) text += `堆栈:\n${log.stack}\n`;
	if (log.filename) text += `位置: ${log.filename}${log.lineno ? `:${log.lineno}` : ''}${log.colno ? `:${log.colno}` : ''}\n`;
	text += `时间: ${log.createdAt}\n`;
	if (log.context && Object.keys(log.context).length > 0) {
		text += `上下文:\n${JSON.stringify(log.context, null, 2)}\n`;
	}

	navigator.clipboard
		.writeText(text)
		.then(() => {
			FpMessage({ type: "success", message: "已复制到剪贴板" });
		})
		.catch(() => {
			FpMessage({ type: "error", message: "复制失败" });
		});
}

/**
 * 删除单条日志
 */
async function deleteLog(log: LogErrorData) {
	try {
		await logService.deleteById(log.id);
		logs.value = logs.value.filter((l) => l.id !== log.id);
		FpMessage({ type: "success", message: "日志已删除" });
	} catch (error) {
		console.error("删除日志失败:", error);
		FpMessage({ type: "error", message: "删除日志失败" });
	}
}

/**
 * 格式化时间
 */
function formatTime(timestamp: string): string {
	const date = new Date(timestamp);
	return date.toLocaleString("zh-CN");
}

/**
 * 获取日志等级颜色
 */
function getLevelColor(level: ErrorLevel): string {
	switch (level) {
		case ErrorLevel.FATAL:
			return "#ff4d4f";
		case ErrorLevel.ERROR:
			return "#ff7875";
		case ErrorLevel.WARNING:
			return "#ffc069";
		case ErrorLevel.INFO:
			return "#69c0ff";
		default:
			return "#999";
	}
}

/**
 * 获取日志等级文本
 */
function getLevelText(level: ErrorLevel): string {
	switch (level) {
		case ErrorLevel.FATAL:
			return "致命";
		case ErrorLevel.ERROR:
			return "错误";
		case ErrorLevel.WARNING:
			return "警告";
		case ErrorLevel.INFO:
			return "信息";
		default:
			return "未知";
	}
}

/**
 * 获取分类文本
 */
function getCategoryText(category: ErrorCategory): string {
	switch (category) {
		case ErrorCategory.NETWORK:
			return "网络";
		case ErrorCategory.GAME_LOGIC:
			return "游戏";
		case ErrorCategory.UI_RENDER:
			return "渲染";
		case ErrorCategory.WORKER:
			return "Worker";
		case ErrorCategory.AUTH:
			return "认证";
		case ErrorCategory.COMPONENT_VALIDATION:
			return "组件验证";
		case ErrorCategory.GAME_RUNTIME:
			return "运行时";
		case ErrorCategory.INIT_TIMEOUT:
			return "初始化超时";
		default:
			return "未知";
	}
}

/**
 * 监听 visible 变化，自动加载日志
 */
watch(
	() => props.visible,
	(visible) => {
		if (visible) {
			loadLogs();
		}
	},
);

/**
 * 组件挂载时加载日志
 */
onMounted(() => {
	if (props.visible) {
		loadLogs();
	}
});

/**
 * 处理对话框关闭
 */
function handleClose() {
	emits("update:visible", false);
}

/**
 * 折叠状态
 */
const expandedLogId = ref<string | null>(null);

function toggleExpand(logId: string) {
	if (expandedLogId.value === logId) {
		expandedLogId.value = null;
	} else {
		expandedLogId.value = logId;
	}
}
</script>

<template>
	<FpDialog
		:visible="visible"
		@update:visible="emits('update:visible', $event)"
		title="日志管理"
		:hidden-footer="true"
		:style="{ width: '50rem', maxHeight: '80vh' }"
	>
		<div class="log-panel">
			<!-- 统计信息 -->
			<div class="log-stats">
				<span class="stat-item">总计: {{ logStats.total }}</span>
				<span class="stat-item fatal">致命: {{ logStats.fatal }}</span>
				<span class="stat-item error">错误: {{ logStats.error }}</span>
				<span class="stat-item warning">警告: {{ logStats.warning }}</span>
				<span class="stat-item info">信息: {{ logStats.info }}</span>
			</div>

			<!-- 筛选栏 -->
			<div class="log-filters">
				<select v-model="filterLevel" class="filter-select">
					<option value="">所有等级</option>
					<option :value="ErrorLevel.FATAL">致命</option>
					<option :value="ErrorLevel.ERROR">错误</option>
					<option :value="ErrorLevel.WARNING">警告</option>
					<option :value="ErrorLevel.INFO">信息</option>
				</select>

				<select v-model="filterCategory" class="filter-select">
					<option value="">所有分类</option>
					<option :value="ErrorCategory.NETWORK">网络</option>
					<option :value="ErrorCategory.GAME_LOGIC">游戏</option>
					<option :value="ErrorCategory.UI_RENDER">渲染</option>
					<option :value="ErrorCategory.WORKER">Worker</option>
					<option :value="ErrorCategory.AUTH">认证</option>
					<option :value="ErrorCategory.COMPONENT_VALIDATION">组件验证</option>
					<option :value="ErrorCategory.GAME_RUNTIME">运行时</option>
					<option :value="ErrorCategory.INIT_TIMEOUT">初始化超时</option>
				</select>

				<input v-model="filterKeyword" type="text" placeholder="搜索关键词..." class="filter-input" />

				<button @click="refreshLogs" class="btn-small" :disabled="loading">
					{{ loading ? "加载中..." : "刷新" }}
				</button>
			</div>

			<!-- 操作栏 -->
			<div class="log-actions">
				<button @click="exportLogs('txt')" class="btn-small">导出 TXT</button>
				<button @click="exportLogs('json')" class="btn-small">导出 JSON</button>
				<button @click="clearLogs" class="btn-small btn-danger">清空日志</button>
				<button @click="handleClose" class="btn-small">关闭</button>
			</div>

			<!-- 日志列表 -->
			<div class="log-list">
				<div
					v-for="log in filteredLogs"
					:key="log.id"
					class="log-item"
					:class="{ expanded: expandedLogId === log.id }"
					:style="{ borderLeftColor: getLevelColor(log.level) }"
				>
					<div class="log-header" @click="toggleExpand(log.id)">
						<span class="log-level" :style="{ color: getLevelColor(log.level) }">
							[{{ getLevelText(log.level) }}]
						</span>
						<span class="log-category">[{{ getCategoryText(log.category) }}]</span>
						<span class="log-message">{{ log.message }}</span>
						<span class="log-time">{{ formatTime(log.createdAt) }}</span>
					</div>
					<div v-if="expandedLogId === log.id" class="log-details">
						<!-- 错误类型 -->
						<div v-if="log.type" class="log-type">
							<div class="detail-title">类型:</div>
							<span class="detail-value">{{ log.type }}</span>
						</div>

						<!-- 完整消息 -->
						<div class="log-full-message">
							<div class="detail-title">完整消息:</div>
							<pre class="detail-content">{{ log.message }}</pre>
						</div>

						<!-- 附加信息 -->
						<div v-if="log.info" class="log-info">
							<div class="detail-title">附加信息:</div>
							<pre class="detail-content">{{ log.info }}</pre>
						</div>

						<!-- 堆栈 -->
						<div v-if="log.stack" class="log-stack">
							<div class="detail-title">堆栈:</div>
							<pre class="detail-content">{{ log.stack }}</pre>
						</div>

						<!-- 文件位置 -->
						<div v-if="log.filename || log.lineno" class="log-location">
							<div class="detail-title">位置:</div>
							<span class="detail-value">{{ log.filename }}{{ log.lineno ? `:${log.lineno}` : '' }}{{ log.colno ? `:${log.colno}` : '' }}</span>
						</div>

						<!-- 上下文 -->
						<div v-if="log.context && Object.keys(log.context).length > 0" class="log-context">
							<div class="detail-title">上下文:</div>
							<pre class="detail-content">{{ JSON.stringify(log.context, null, 2) }}</pre>
						</div>

						<!-- 时间戳 -->
						<div class="log-timestamp">
							<div class="detail-title">时间:</div>
							<span class="detail-value">{{ log.createdAt }}</span>
						</div>

						<div class="log-actions-row">
							<button @click="copyLog(log)" class="btn-small">复制完整信息</button>
							<button @click="deleteLog(log)" class="btn-small btn-danger">删除</button>
						</div>
					</div>
				</div>

				<div v-if="filteredLogs.length === 0" class="log-empty">
					{{ loading ? "加载中..." : "暂无日志" }}
				</div>
			</div>
		</div>
	</FpDialog>
</template>

<style lang="scss" scoped>
@use "@src/assets/variables" as *;
@use "@mine-monopoly/style/variables" as fp;

.log-panel {
	display: flex;
	flex-direction: column;
	gap: 1rem;
	min-height: 25rem;
}

.log-stats {
	display: flex;
	gap: 1rem;
	padding: 0.5rem 1rem;
	background-color: var(--fp-color-bg-light, #f5f5f5);
	border-radius: 0.25rem;

	.stat-item {
		font-size: 0.875rem;

		&.fatal {
			color: #ff4d4f;
		}
		&.error {
			color: #ff7875;
		}
		&.warning {
			color: #ffc069;
		}
		&.info {
			color: #69c0ff;
		}
	}
}

.log-filters {
	display: flex;
	gap: 0.5rem;
	flex-wrap: wrap;

	.filter-select,
	.filter-input {
		padding: 0.5rem;
		border: 0.0625rem solid var(--fp-color-border, #ddd);
		border-radius: 0.25rem;
		font-size: 0.875rem;
	}

	.filter-select {
		min-width: 6.25rem;
	}

	.filter-input {
		flex: 1;
		min-width: 9.375rem;
	}
}

.log-actions {
	display: flex;
	gap: 0.5rem;
	justify-content: flex-end;
}

.log-list {
	flex: 1;
	overflow-y: auto;
	max-height: 31.25rem;
	border: 0.0625rem solid var(--fp-color-border, #ddd);
	border-radius: 0.25rem;
}

.log-item {
	border-left: 0.25rem solid #ddd;
	padding: 0.75rem;
	margin-bottom: 0.5rem;
	background-color: white;
	transition: background-color 0.2s;

	&:hover {
		background-color: var(--fp-color-bg-light, #f9f9f9);
	}

	&.expanded {
		background-color: var(--fp-color-bg-light, #f9f9f9);
	}
}

.log-header {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	cursor: pointer;
	flex-wrap: wrap;
	align-items: flex-start;
}

.log-level {
	font-weight: bold;
	font-size: 0.875rem;
	white-space: nowrap;
}

.log-category {
	font-size: 0.75rem;
	color: #666;
	white-space: nowrap;
}

.log-message {
	flex: 1;
	font-size: 0.875rem;
	word-break: break-word;
}

.log-time {
	font-size: 0.75rem;
	color: #999;
	white-space: nowrap;
}

.log-details {
	margin-top: 0.75rem;
	padding-top: 0.75rem;
	border-top: 0.0625rem solid #eee;
}

.log-type,
.log-full-message,
.log-info,
.log-stack,
.log-location,
.log-context,
.log-timestamp {
	margin-bottom: 0.75rem;

	&:last-child {
		margin-bottom: 0;
	}
}

.detail-title {
	font-weight: bold;
	font-size: 0.875rem;
	margin-bottom: 0.25rem;
	color: var(--fp-color-text-regular, #333);
}

.detail-value {
	font-size: 0.875rem;
	color: #333;
	word-break: break-all;
}

.detail-content {
	margin: 0;
	padding: 0.5rem;
	background-color: #f5f5f5;
	border-radius: 0.25rem;
	font-size: 0.75rem;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 12.5rem;
	overflow-y: auto;
}

.log-actions-row {
	display: flex;
	gap: 0.5rem;
	margin-top: 0.5rem;
}

.log-empty {
	text-align: center;
	padding: 2rem;
	color: #999;
}
</style>
