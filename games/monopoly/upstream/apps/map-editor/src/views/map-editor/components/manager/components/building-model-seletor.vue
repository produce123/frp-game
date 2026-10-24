<script setup lang="ts">
import { ResourcesType, useResourceStore } from "@src/stores";
import { computed, onUpdated, ref, toRaw } from "vue";

const props = defineProps<{ modelIdList: string[] | undefined }>();

const modelIdList = ref(props.modelIdList || []);

const emits = defineEmits(["submit"]);

const modelList = computed(() => useResourceStore().models);

// 添加一行
function addItem() {
	modelIdList.value.push("");
}

// 删除一行
function removeItem(index: number) {
	modelIdList.value.splice(index, 1);
}

function handleSubmit() {
	emits("submit", modelIdList);
}
</script>

<template>
		<div class="selector-container">
			<a-alert
				message="此处修改的为地皮升级的默认模型，0级为地皮模型、1级为建房一次模型以此类推，如果地图有多级建筑，系统会根据此处按顺序选择模型"
				type="info"
				style="margin-bottom: 10px"
				show-icon
			/>
			<a-form @submit="handleSubmit" :model="modelIdList">
				<a-form-item v-for="(value, index) in modelIdList" :key="index" :label="`LV${index} 模型:`">
					<a-row :gutter="16">
						<a-col :span="19">
							<a-select v-model:value="modelIdList[index]">
								<a-select-option :value="model.id" v-for="model in modelList" :key="model.id">{{
									model.name
								}}</a-select-option>
							</a-select>
						</a-col>
						<a-col :span="4">
							<a-button danger type="primary" @click="removeItem(index)">删除</a-button>
						</a-col>
					</a-row>
				</a-form-item>

				<a-form-item>
					<a-button type="dashed" block @click="addItem">+ 添加等级模型</a-button>
				</a-form-item>
				<a-form-item>
					<a-button style="float: right" type="primary" htmlType="submit">确定修改</a-button>
				</a-form-item>
			</a-form>
		</div>
</template>

<style lang="scss" scoped>
.selector-container {
	padding: 12px;
	max-height: 60vh;
	overflow-y: auto;
}
</style>
