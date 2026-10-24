<script setup lang="ts">
import { AdminUserListItem } from "@/interfaces/interfaces";
import { computed, ref, watch } from "vue";
import { generateMapKey, resetMapKey, revokeMapKey, updateUser, resetMapKeyUploadCount } from "@/utils/api/user";
import { getAdminGameMapList, reviewGameMap } from "@/utils/api/game-map";
import { message } from "ant-design-vue";
import type { GameMapInDb, GameMapStatus } from "@mine-monopoly/types";

const props = defineProps<{ open: boolean; user?: AdminUserListItem }>();
const emits = defineEmits(["update:open", "change"]);

// 组件内维护的用户副本：key 操作后即时刷新显示，不依赖父组件重新传值
const localUser = ref<AdminUserListItem | undefined>(undefined);

const mapList = ref<GameMapInDb[]>([]);
const mapLoading = ref(false);
const mapTotal = ref(0);
const mapPage = ref(1);
const mapPageSize = ref(8);
const mapStatusFilter = ref<GameMapStatus | "all">("all");
const keyLoading = ref(false);
const quotaInput = ref<number | null>(null);
const savingQuota = ref(false);
const sizeLimitInput = ref<number | null>(null);
const savingSizeLimit = ref(false);
const dailyLimitInput = ref<number | null>(null);
const savingDailyLimit = ref(false);
const resettingCount = ref(false);
const rejectVisible = ref(false);
const rejectMap = ref<GameMapInDb | undefined>(undefined);
const rejectReason = ref("");
const rejectSubmitting = ref(false);

const title = computed(() => (localUser.value ? `${localUser.value.username} 的创作者管理` : "创作者管理"));

const mapStatusOptions = [
	{ label: "全部", value: "all" },
	{ label: "审核中", value: "reviewing" },
	{ label: "已发布", value: "published" },
	{ label: "已驳回", value: "rejected" },
	{ label: "已下架", value: "offline" },
];

const mapColumns = [
	{ title: "地图", dataIndex: "name", key: "name" },
	{ title: "状态", dataIndex: "status", key: "status" },
	{ title: "发布版", dataIndex: "version", key: "version" },
	{ title: "提交版", dataIndex: "pendingVersion", key: "pendingVersion" },
	{ title: "驳回原因", dataIndex: "rejectReason", key: "rejectReason" },
	{ title: "审核文件", key: "files" },
	{ title: "操作", key: "action" },
];

watch(
	() => props.open,
	(open) => {
		if (open) {
			// 打开时同步最新用户数据（深拷贝，避免直接改 props）
			localUser.value = props.user ? { ...props.user } : undefined;
			quotaInput.value = props.user?.mapQuota ?? null;
			sizeLimitInput.value = props.user?.mapUploadSizeLimit ?? null;
			dailyLimitInput.value = props.user?.mapDailyUploadLimit ?? null;
			mapPage.value = 1;
			updateMapList();
		}
	}
);

// 父组件列表刷新后（如配额/地图数变化）同步本地副本
watch(
	() => props.user,
	(user) => {
		if (user) localUser.value = { ...user };
	}
);

/** 保存地图配额（留空表示未开通） */
async function handleSaveQuota() {
	if (!localUser.value) return;
	if (!localUser.value.isCreator) {
		message.warning("该用户不是创作者，无需配置地图配额");
		return;
	}
	savingQuota.value = true;
	try {
		const quota = quotaInput.value === null || quotaInput.value === undefined || Number.isNaN(quotaInput.value)
			? null
			: Math.max(0, Math.round(quotaInput.value));
		await updateUser({ id: localUser.value.id, mapQuota: quota });
		localUser.value.mapQuota = quota;
		quotaInput.value = quota;
		message.success("地图配额已保存");
		emits("change");
	} finally {
		savingQuota.value = false;
	}
}

/** 保存上传大小限制（MB，留空表示使用默认 50MB） */
async function handleSaveSizeLimit() {
	if (!localUser.value) return;
	if (!localUser.value.isCreator) {
		message.warning("该用户不是创作者，无需配置上传大小限制");
		return;
	}
	savingSizeLimit.value = true;
	try {
		const limit = sizeLimitInput.value === null || sizeLimitInput.value === undefined || Number.isNaN(sizeLimitInput.value)
			? null
			: Math.max(1, Math.round(sizeLimitInput.value));
		await updateUser({ id: localUser.value.id, mapUploadSizeLimit: limit });
		localUser.value.mapUploadSizeLimit = limit;
		sizeLimitInput.value = limit;
		message.success("上传大小限制已保存");
		emits("change");
	} finally {
		savingSizeLimit.value = false;
	}
}

/** 保存每日上传次数限制（留空表示使用默认 3 次/天） */
async function handleSaveDailyLimit() {
	if (!localUser.value) return;
	if (!localUser.value.isCreator) {
		message.warning("该用户不是创作者，无需配置每日上传次数限制");
		return;
	}
	savingDailyLimit.value = true;
	try {
		const limit = dailyLimitInput.value === null || dailyLimitInput.value === undefined || Number.isNaN(dailyLimitInput.value)
			? null
			: Math.max(1, Math.round(dailyLimitInput.value));
		await updateUser({ id: localUser.value.id, mapDailyUploadLimit: limit });
		localUser.value.mapDailyUploadLimit = limit;
		dailyLimitInput.value = limit;
		message.success("每日上传次数限制已保存");
		emits("change");
	} finally {
		savingDailyLimit.value = false;
	}
}

/** 重置今日已上传次数（跨天自动归零，管理端可手动提前重置） */
async function handleResetTodayCount() {
	if (!localUser.value) return;
	resettingCount.value = true;
	try {
		await resetMapKeyUploadCount(localUser.value.id);
		localUser.value.todayUploaded = 0;
		message.success("今日上传次数已重置");
		emits("change");
	} finally {
		resettingCount.value = false;
	}
}

function close() {
	emits("update:open", false);
}

function statusLabel(status: GameMapStatus) {
	return ({ reviewing: "审核中", published: "已发布", rejected: "已驳回", offline: "已下架" } as const)[status];
}

function statusColor(status: GameMapStatus) {
	return ({ reviewing: "gold", published: "green", rejected: "red", offline: "default" } as const)[status];
}

/** 待审核版本的产物/源文件（审核中可下载） */
function pendingFiles(map: GameMapInDb) {
	return [
		...(map.pendingUrl ? [{ label: ".mmmap", url: map.pendingUrl }] : []),
		...(map.pendingSourceUrl ? [{ label: ".fpmap", url: map.pendingSourceUrl }] : []),
	];
}

/** 当前公开版本的产物/源文件（已发布可下载） */
function publishedFiles(map: GameMapInDb) {
	return [
		...(map.mapUrl ? [{ label: ".mmmap", url: map.mapUrl }] : []),
		...(map.sourceUrl ? [{ label: ".fpmap", url: map.sourceUrl }] : []),
	];
}

async function updateMapList() {
	if (!localUser.value) return;
	mapLoading.value = true;
	try {
		const data = await getAdminGameMapList({
			page: mapPage.value,
			size: mapPageSize.value,
			creatorId: localUser.value.id,
			status: mapStatusFilter.value,
		});
		mapList.value = data.gameMapList;
		mapTotal.value = data.total;
	} finally {
		mapLoading.value = false;
	}
}

function handleMapPageChange(page: number) {
	mapPage.value = page;
	updateMapList();
}

function handleMapStatusFilterChange() {
	mapPage.value = 1;
	updateMapList();
}

async function handleReview(map: GameMapInDb, action: "approve" | "reject" | "offline" | "online" | "delete") {
	if (action === "reject") {
		rejectMap.value = map;
		rejectReason.value = "";
		rejectVisible.value = true;
		return;
	}
	await reviewGameMap({ mapId: map.id, action, reason: "" });
	await updateMapList();
	emits("change");
}

async function confirmReject() {
	if (!rejectMap.value) return;
	const reason = rejectReason.value.trim();
	if (!reason) {
		message.warning("请填写驳回原因");
		return;
	}
	rejectSubmitting.value = true;
	try {
		await reviewGameMap({ mapId: rejectMap.value.id, action: "reject", reason });
		rejectVisible.value = false;
		rejectMap.value = undefined;
		await updateMapList();
		emits("change");
	} finally {
		rejectSubmitting.value = false;
	}
}

async function handleGenerateKey() {
	if (!localUser.value) return;
	keyLoading.value = true;
	try {
		const data = await generateMapKey(localUser.value.id);
		if (localUser.value) localUser.value.mapKey = data.key;
		message.success("key 生成成功");
		emits("change");
	} finally {
		keyLoading.value = false;
	}
}

async function handleResetKey() {
	if (!localUser.value) return;
	keyLoading.value = true;
	try {
		const data = await resetMapKey(localUser.value.id);
		if (localUser.value) localUser.value.mapKey = data.key;
		message.success("key 已重置");
		emits("change");
	} finally {
		keyLoading.value = false;
	}
}

async function handleRevokeKey() {
	if (!localUser.value) return;
	keyLoading.value = true;
	try {
		await revokeMapKey(localUser.value.id);
		if (localUser.value) localUser.value.mapKey = null;
		message.success("key 已吊销");
		emits("change");
	} finally {
		keyLoading.value = false;
	}
}
</script>

<template>
	<a-modal
		:open="open"
		:title="title"
		:footer="null"
		:width="'min(900px, 96vw)'"
		destroy-on-close
		@cancel="close"
	>
		<div class="creator-modal">
			<!-- 上区：key 管理 -->
			<div class="key-section">
				<div class="section-title">上传 Key</div>
				<div class="key-row">
					<span class="key-label">地图配额：</span>
					<a-input-number
						v-model:value="quotaInput"
						:min="0"
						:precision="0"
						style="width: 120px; margin-right: 10px;"
						placeholder="未开通"
						size="small"
					/>
					<span class="key-value">个（已用 {{ localUser?.mapCount ?? 0 }}，留空表示未开通）</span>
					<a-button size="small" :loading="savingQuota" @click="handleSaveQuota">保存</a-button>
				</div>
				<div class="key-row">
					<span class="key-label">上传大小限制：</span>
					<a-input-number
						v-model:value="sizeLimitInput"
						:min="1"
						:precision="0"
						style="width: 120px; margin-right: 10px;"
						placeholder="默认 50"
						size="small"
					/>
					<span class="key-value">MB（留空使用默认 50MB）</span>
					<a-button size="small" :loading="savingSizeLimit" @click="handleSaveSizeLimit">保存</a-button>
				</div>
				<div class="key-row">
					<span class="key-label">每日上传次数：</span>
					<a-input-number
						v-model:value="dailyLimitInput"
						:min="1"
						:precision="0"
						style="width: 120px; margin-right: 10px;"
						placeholder="默认 3"
						size="small"
					/>
					<span class="key-value">次/天（留空使用默认 3 次）</span>
					<a-button size="small" :loading="savingDailyLimit" @click="handleSaveDailyLimit">保存</a-button>
				</div>
				<div class="key-row">
					<span class="key-label">今日已上传：</span>
					<span class="key-value">{{ localUser?.todayUploaded ?? 0 }} 次</span>
					<a-popconfirm title="确认重置今日上传次数？" @confirm="handleResetTodayCount">
						<a-button size="small" :loading="resettingCount" :disabled="!localUser?.todayUploaded">重置今日次数</a-button>
					</a-popconfirm>
				</div>
				<div class="key-row">
					<span class="key-label">Key：</span>
					<a-typography-text v-if="localUser?.mapKey" :copyable="{ text: localUser.mapKey }" class="key-text">
						{{ localUser.mapKey }}
					</a-typography-text>
					<span v-else class="key-muted">未生成</span>
				</div>
				<div class="key-actions">
					<a-space wrap>
						<a-popconfirm title="为该用户生成 key？" @confirm="handleGenerateKey">
							<a-button size="small" :disabled="!!localUser?.mapKey" :loading="keyLoading">生成</a-button>
						</a-popconfirm>
						<a-popconfirm title="确认重置 key？旧 key 将立即失效" @confirm="handleResetKey">
							<a-button size="small" :disabled="!localUser?.mapKey" :loading="keyLoading">重置</a-button>
						</a-popconfirm>
						<a-popconfirm title="确认吊销 key？" @confirm="handleRevokeKey">
							<a-button size="small" danger :disabled="!localUser?.mapKey" :loading="keyLoading">吊销</a-button>
						</a-popconfirm>
					</a-space>
				</div>
			</div>

			<a-divider />

			<!-- 下区：地图管理 -->
			<div class="map-section">
				<div class="section-title">地图管理</div>
				<a-select
					v-model:value="mapStatusFilter"
					:options="mapStatusOptions"
					style="width: 160px; margin-bottom: 10px"
					@change="handleMapStatusFilterChange"
				/>
				<a-table
					:columns="mapColumns"
					:data-source="mapList"
					:loading="mapLoading"
					row-key="id"
					size="small"
					:pagination="{
						current: mapPage,
						pageSize: mapPageSize,
						total: mapTotal,
						showTotal: (t: number) => `${t} 个地图`,
						onChange: handleMapPageChange,
						showLessItems: true,
					}"
				>
					<template #bodyCell="{ column, record }">
						<template v-if="column.key === 'status'">
							<a-tag :color="statusColor(record.status)">{{ statusLabel(record.status) }}</a-tag>
						</template>
						<template v-if="column.key === 'files'">
							<a-space wrap>
								<a v-for="file in record.pendingUrl ? pendingFiles(record) : publishedFiles(record)" :key="file.label" :href="file.url" target="_blank" rel="noopener">
									{{ file.label }}
								</a>
							</a-space>
						</template>
						<template v-if="column.key === 'action'">
							<a-space wrap>
								<a-button v-if="record.pendingUrl" size="small" type="link" @click="handleReview(record, 'approve')">通过</a-button>
								<a-button v-if="record.pendingUrl" size="small" type="link" danger @click="handleReview(record, 'reject')">驳回</a-button>
								<a-button v-if="record.status === 'published'" size="small" type="link" @click="handleReview(record, 'offline')">下架</a-button>
								<a-button v-if="record.status === 'offline'" size="small" type="link" @click="handleReview(record, 'online')">上架</a-button>
								<a-popconfirm title="确认删除该地图？" @confirm="handleReview(record, 'delete')">
									<a-button size="small" type="link" danger>删除</a-button>
								</a-popconfirm>
							</a-space>
						</template>
					</template>
				</a-table>
			</div>
		</div>
	</a-modal>

	<a-modal v-model:open="rejectVisible" title="驳回地图" :confirm-loading="rejectSubmitting" :ok-button-props="{ danger: true }" ok-text="确认驳回" cancel-text="取消" @ok="confirmReject" destroy-on-close>
		<a-form layout="vertical">
			<a-form-item label="地图名称">
				<span>{{ rejectMap?.name }}</span>
			</a-form-item>
			<a-form-item label="驳回原因" required>
				<a-textarea v-model:value="rejectReason" :rows="3" placeholder="请输入驳回原因（作者可见）" :maxlength="200" show-count />
			</a-form-item>
		</a-form>
	</a-modal>
</template>

<style lang="scss" scoped>
.creator-modal {
	.key-section {
		display: flex;
		flex-direction: column;
		gap: 8px;

		.section-title {
			font-weight: bold;
			color: #333;
		}

		.key-row {
			.key-label {
				color: #888;
			}
			.key-value {
				font-variant-numeric: tabular-nums;
				margin-right: 10px;
			}
			.key-text {
				max-width: 480px;
				word-break: break-all;
			}
			.key-muted {
				color: #bbb;
			}
		}

		.key-actions {
			margin-top: 4px;
		}
	}

	.map-section {
		.section-title {
			font-weight: bold;
			color: #333;
			margin-bottom: 10px;
		}
	}
}
</style>
