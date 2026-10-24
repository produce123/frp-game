import { _axios } from "@/utils/axios";
import type { ApiResponse } from "@mine-monopoly/types";
import type { AdminUserListItem } from "@/interfaces/interfaces";

export const getUserList = async (
	page: number,
	size: number,
	options?: {
		search?: string;
		online?: boolean;
		isAdmin?: boolean;
		isCreator?: boolean;
		sortBy?: "createTime" | "lastActiveTime" | "username" | "useraccount";
		sortOrder?: "ASC" | "DESC";
	}
) => {
	const res = await _axios.get<ApiResponse<{ total: number; userList: AdminUserListItem[]; current: number }>>(
		"/user/list",
		{
			params: {
				page,
				size,
				search: options?.search,
				online: options?.online,
				isAdmin: options?.isAdmin,
				isCreator: options?.isCreator,
				sortBy: options?.sortBy,
				sortOrder: options?.sortOrder,
			},
		}
	);
	return res.data.data;
};

export const createUser = async (params: {
	useraccount: string;
	username: string;
	password: string;
	color: string;
	isAdmin: boolean;
	isCreator?: boolean;
}) => {
	const res = await _axios.post<ApiResponse<string>>("/user/create", params);
	return res.data.data;
};

export const updateUser = async (params: {
	id: string;
	username?: string;
	password?: string;
	color?: string;
	isAdmin?: boolean;
	isCreator?: boolean;
	mapQuota?: number | null;
	mapUploadSizeLimit?: number | null;
	mapDailyUploadLimit?: number | null;
}) => {
	const res = await _axios.post<ApiResponse<string>>("/user/update", params);
	return res.data.data;
};

export const deleteUser = async (id: string) => {
	const res = await _axios.delete<ApiResponse<string>>("/user/delete", { params: { id } });
	return res.data.data;
};

export const generateMapKey = async (userId: string) => {
	const res = await _axios.post<ApiResponse<{ key: string }>>("/user/key", { userId });
	return res.data.data;
};

export const resetMapKey = async (userId: string) => {
	const res = await _axios.post<ApiResponse<{ key: string }>>("/user/key/reset", { userId });
	return res.data.data;
};

export const revokeMapKey = async (userId: string) => {
	const res = await _axios.post<ApiResponse<{ key: string } | null>>("/user/key/revoke", { userId });
	return res.data.data;
};

export const resetMapKeyUploadCount = async (userId: string) => {
	const res = await _axios.post<ApiResponse<{ todayUploaded: number }>>("/user/key/reset-upload-count", { userId });
	return res.data.data;
};

export const getLoginCode = async () => {
	const res = await _axios.get<ApiResponse<{ img: { type: string; data: number[] }; uuid: string }>>("/user/get-login-code");
	return res.data.data;
};

export const getLoginCodeState = async (uuid: string) => {
	const res = await _axios.get<ApiResponse<{ codeState: number; token?: string }>>(`/user/get-code-state?uuid=${uuid}`);
	return res.data.data;
};

export const isAdmin = async () => {
	const res = await _axios.get<ApiResponse<{ isAdmin: boolean }>>("/user/is-admin");
	return res.data.data;
};

export const checkAdminIdentity = () =>
	new Promise<boolean>(async (resolve, reject) => {
		try {
			const _isAdmin = (await isAdmin()).isAdmin;
			if (_isAdmin) {
				resolve(true);
			} else {
				reject(false);
			}
		} catch (e) {
			reject(false);
		}
	});