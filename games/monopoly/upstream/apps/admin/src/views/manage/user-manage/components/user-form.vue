<script setup lang="ts">
import { AdminUserListItem } from "@/interfaces/interfaces";
import { createUser, updateUser } from "@/utils/api/user";
import { getEncryption } from "@/utils/auth";
import { FormInstance } from "ant-design-vue";
import { computed, onMounted, reactive, ref } from "vue";
import { Rule } from "ant-design-vue/es/form";

const props = defineProps<{ user?: AdminUserListItem }>();
const emits = defineEmits(["finish"]);

const isEdit = computed(() => !!props.user);
const formRef = ref<FormInstance>();
const confirmLoading = ref(false);

const formValue = reactive({
	useraccount: "",
	username: "",
	password: "",
	color: "#1677ff",
	isAdmin: false,
	isCreator: false,
});

onMounted(() => {
	if (props.user) {
		formValue.useraccount = props.user.useraccount;
		formValue.username = props.user.username;
		formValue.color = props.user.color;
		formValue.isAdmin = props.user.isAdmin;
		formValue.isCreator = props.user.isCreator;
	}
});

const rules = computed<Record<string, Rule[]>>(() => ({
	useraccount: [{ required: true, message: "请输入账号" }],
	username: [{ required: true, message: "请输入用户名" }],
	password: isEdit.value
		? [
				{
					validator: async (_rule: Rule, value: string) => {
						if (value && value.length < 6) {
							throw new Error("密码长度不能少于6位");
						}
					},
				},
			]
		: [
				{ required: true, message: "请输入密码" },
				{ min: 6, message: "密码长度不能少于6位" },
			],
}));

async function onFinish() {
	confirmLoading.value = true;
	try {
		if (isEdit.value) {
			const encryptedPassword = formValue.password ? await getEncryption(formValue.password) : "";
			await updateUser({
				id: props.user!.id,
				username: formValue.username,
				password: encryptedPassword,
				color: formValue.color,
				isAdmin: formValue.isAdmin,
				isCreator: formValue.isCreator,
			});
		} else {
			const encryptedPassword = await getEncryption(formValue.password);
			await createUser({
				useraccount: formValue.useraccount,
				username: formValue.username,
				password: encryptedPassword,
				color: formValue.color,
				isAdmin: formValue.isAdmin,
				isCreator: formValue.isCreator,
			});
		}
		emits("finish");
	} finally {
		confirmLoading.value = false;
	}
}
</script>

<template>
	<a-form :model="formValue" @finish="onFinish" ref="formRef" :rules="rules" layout="vertical">
		<a-form-item label="账号" name="useraccount">
			<a-input v-model:value="formValue.useraccount" :disabled="isEdit" placeholder="3-20位字母、数字或下划线" />
		</a-form-item>

		<a-form-item label="用户名" name="username">
			<a-input v-model:value="formValue.username" placeholder="1-20位" />
		</a-form-item>

		<a-form-item label="密码" name="password">
			<a-input-password
				v-model:value="formValue.password"
				:placeholder="isEdit ? '留空则不修改' : '至少6位'"
			/>
		</a-form-item>

		<a-form-item label="颜色" name="color">
			<input type="color" class="color-input" v-model="formValue.color" />
		</a-form-item>

		<a-form-item label="管理员" name="isAdmin">
			<a-switch v-model:checked="formValue.isAdmin" />
		</a-form-item>

		<a-form-item label="创作者" name="isCreator">
			<a-switch v-model:checked="formValue.isCreator" />
			<div class="form-tip">开启后用户可上传地图（默认获得 1 个地图配额），上传 Key、更多配额与限制请在创作者管理中配置</div>
		</a-form-item>

		<a-form-item>
			<a-button style="float: right" type="primary" html-type="submit" :loading="confirmLoading">
				{{ isEdit ? "保存" : "创建" }}
			</a-button>
		</a-form-item>
	</a-form>
</template>

<style lang="scss" scoped>
.form-tip {
	font-size: 12px;
	color: #999;
	margin-top: 2px;
}

.color-input {
	width: 60px;
	height: 32px;
	padding: 2px;
	border: 1px solid #d9d9d9;
	border-radius: 6px;
	cursor: pointer;
	background: transparent;

	&::-webkit-color-swatch-wrapper {
		padding: 2px;
	}

	&::-webkit-color-swatch {
		border: none;
		border-radius: 4px;
	}
}
</style>