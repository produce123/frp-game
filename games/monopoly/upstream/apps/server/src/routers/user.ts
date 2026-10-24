import { Router } from "express";
import { env } from "@mine-monopoly/env";
import { ResInterface } from "#src/interfaces/res";
import { verToken } from "#src/utils/token";
import { privateKey, encryptionKey } from "#src/utils/rsakey";
import { createUser, deleteUser, getUserById, getUserList, updateUser, userLogin } from "#src/db/api/user";
import { AppDataSource } from "#src/db/dbConnecter";
import { User } from "#src/db/entities/User";
import { setToken, setRefreshToken, verToken as verifyToken } from "#src/utils/token";
import { avatarMulter, withFileCleanup, cleanupTempFiles, getStorage } from "#src/utils/storage";
import { getFileNameInPath, randomString } from "#src/utils";
import { generateMapKeyForUser, resetMapKeyForUser, revokeMapKeyForUser } from "#src/db/api/map-key";
import { resetTodayUploadCountForUser } from "#src/db/api/map-upload-counter";
import { createAdminAuditLog } from "#src/db/api/admin-audit-log";
import { getUserIdFromToken } from "#src/utils/api-key";
import { serverLog } from "#src/utils/logger";
import { GameMap } from "#src/db/entities/GameMap";

export const routerUser = Router();

function getAdminId(req: { headers: { authorization?: string } }) {
	try {
		return getUserIdFromToken(req.headers.authorization) || null;
	} catch {
		return null;
	}
}

function getMapQuota(value: unknown) {
	if (value === undefined) return undefined;
	if (value === null || value === "") return null;
	const quota = Number(value);
	if (!Number.isInteger(quota) || quota < 0) throw new Error("mapQuota 参数类型错误");
	return quota;
}

function getMapUploadSizeLimit(value: unknown) {
	if (value === undefined) return undefined;
	if (value === null || value === "") return null;
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1) throw new Error("mapUploadSizeLimit 参数类型错误");
	return limit;
}

function getMapDailyUploadLimit(value: unknown) {
	if (value === undefined) return undefined;
	if (value === null || value === "") return null;
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1) throw new Error("mapDailyUploadLimit 参数类型错误");
	return limit;
}

function getUrlStorageKey(url?: string | null) {
	if (!url) return null;
	const fileName = getFileNameInPath(url);
	if (!fileName) return null;
	return `${env("GAME_MAP_STORAGE_PATH", "monopoly/game-map")}/${fileName}`;
}

async function deleteMapFiles(maps: GameMap[]) {
	const keys = maps
		.flatMap((map) => [map.coverUrl, map.mapUrl, map.pendingUrl, map.sourceUrl, map.pendingSourceUrl])
		.map(getUrlStorageKey)
		.filter((key): key is string => Boolean(key));
	if (keys.length === 0) return;
	try {
		await getStorage().delete([...new Set(keys)]);
	} catch (e: any) {
		// 文件删除失败不应阻塞删除用户主流程，失败文件由运维清理
		serverLog(`Delete user map files failed (${keys.join(", ")}): ${e.message}`, "warn");
	}
}

routerUser.get("/is-admin", async (req, res) => {
	const token = req.headers.authorization;
	if (!token) {
		const resContent: ResInterface = { status: 401, msg: "没有携带token" };
		res.status(401).json(resContent);
		return;
	}
	let tokenInfo;
	try {
		tokenInfo = await verToken(token);
	} catch {
		const resContent: ResInterface = { status: 401, msg: "token过期或失效，请重新登录" };
		res.status(401).json(resContent);
		return;
	}
	if (!tokenInfo) {
		const resContent: ResInterface = { status: 401, msg: "token解析失败" };
		res.status(401).json(resContent);
		return;
	}
	const isAdmin = tokenInfo.isAdmin;
	if (isAdmin) {
		const resContent: ResInterface = { status: 200, data: { isAdmin: true } };
		res.status(200).json(resContent);
	} else {
		const resContent: ResInterface = { status: 403, msg: "你不是管理员喔" };
		res.status(403).json(resContent);
	}
});

routerUser.get("/list", async (req, res) => {
	const { page = 1, size = 8, search, online, isAdmin, isCreator, sortBy, sortOrder } = req.query;
	try {
		const onlineFilter = online === "true" ? true : online === "false" ? false : undefined;
		const isAdminFilter = isAdmin === "true" ? true : isAdmin === "false" ? false : undefined;
		const isCreatorFilter = isCreator === "true" ? true : isCreator === "false" ? false : undefined;
		const { userList, total } = await getUserList(
			parseInt(page.toString()),
			parseInt(size.toString()),
			{
				search: search?.toString(),
				online: onlineFilter,
				isAdmin: isAdminFilter,
				isCreator: isCreatorFilter,
				sortBy:
					sortBy === "createTime" ||
					sortBy === "lastActiveTime" ||
					sortBy === "username" ||
					sortBy === "useraccount"
						? sortBy
						: undefined,
				sortOrder: sortOrder === "ASC" || sortOrder === "DESC" ? sortOrder : undefined,
			}
		);
		await createAdminAuditLog({
			adminId: getAdminId(req),
			action: "map_key_view",
			detail: JSON.stringify({ page, size, search: search?.toString() || "" }),
		});
		const resMsg: ResInterface = { status: 200, data: { total, current: parseInt(page.toString()), userList } };
		res.status(200).json(resMsg);
	} catch {
		const resMsg: ResInterface = { status: 500, msg: "获取用户列表失败" };
		res.status(500).json(resMsg);
	}
});

routerUser.post("/key", async (req, res) => {
	const { userId } = req.body;
	if (!userId) {
		const resContent: ResInterface = { status: 400, msg: "缺少用户ID" };
		res.status(400).json(resContent);
		return;
	}
	try {
		const user = await getUserById(userId);
		if (!user) throw Object.assign(new Error("用户不存在"), { statusCode: 404 });
		if (!user.isCreator) throw Object.assign(new Error("该用户不是创作者，无法生成 key"), { statusCode: 403 });
		const key = await generateMapKeyForUser(userId);
		await createAdminAuditLog({ adminId: getAdminId(req), targetUserId: userId, action: "map_key_generate" });
		const resContent: ResInterface = { status: 200, msg: "生成 key 成功", data: key };
		res.status(200).json(resContent);
	} catch (e: any) {
		const status = e.statusCode || 500;
		const resContent: ResInterface = { status, msg: e.message || "生成 key 失败" };
		res.status(status).json(resContent);
	}
});

routerUser.post("/key/reset", async (req, res) => {
	const { userId } = req.body;
	if (!userId) {
		const resContent: ResInterface = { status: 400, msg: "缺少用户ID" };
		res.status(400).json(resContent);
		return;
	}
	try {
		const key = await resetMapKeyForUser(userId);
		await createAdminAuditLog({ adminId: getAdminId(req), targetUserId: userId, action: "map_key_reset" });
		const resContent: ResInterface = { status: 200, msg: "重置 key 成功", data: key };
		res.status(200).json(resContent);
	} catch (e: any) {
		const resContent: ResInterface = { status: 500, msg: e.message || "重置 key 失败" };
		res.status(500).json(resContent);
	}
});

routerUser.post("/key/revoke", async (req, res) => {
	const { userId } = req.body;
	if (!userId) {
		const resContent: ResInterface = { status: 400, msg: "缺少用户ID" };
		res.status(400).json(resContent);
		return;
	}
	try {
		const key = await revokeMapKeyForUser(userId);
		await createAdminAuditLog({ adminId: getAdminId(req), targetUserId: userId, action: "map_key_revoke" });
		const resContent: ResInterface = { status: 200, msg: "吊销 key 成功", data: key };
		res.status(200).json(resContent);
	} catch (e: any) {
		const resContent: ResInterface = { status: 500, msg: e.message || "吊销 key 失败" };
		res.status(500).json(resContent);
	}
});

routerUser.post("/key/reset-upload-count", async (req, res) => {
	const { userId } = req.body;
	if (!userId) {
		const resContent: ResInterface = { status: 400, msg: "缺少用户ID" };
		res.status(400).json(resContent);
		return;
	}
	try {
		await resetTodayUploadCountForUser(userId);
		await createAdminAuditLog({ adminId: getAdminId(req), targetUserId: userId, action: "map_key_reset_upload_count" });
		const resContent: ResInterface = { status: 200, msg: "今日上传次数已重置", data: { todayUploaded: 0 } };
		res.status(200).json(resContent);
	} catch (e: any) {
		const resContent: ResInterface = { status: 500, msg: e.message || "重置上传次数失败" };
		res.status(500).json(resContent);
	}
});

routerUser.get("/info", async (req, res) => {
	const token = req.body.token || req.header("authorization") || req.query.token;
	if (token) {
		try {
			const { userId } = verToken(token)!;
			const user = await getUserById(userId);
			if (user) {
				const resMsg: ResInterface = { status: 200, data: user };
				res.status(200).json(resMsg);
			} else {
				const resMsg: ResInterface = { status: 401, msg: "获取用户信息异常" };
				res.status(401).json(resMsg);
			}
		} catch {
			const resMsg: ResInterface = { status: 401, msg: "Token过期或失效，请重新登录" };
			res.status(401).json(resMsg);
		}
	} else {
		const resMsg: ResInterface = { status: 401, msg: "身份验证失败：没有附带token", data: {} };
		res.status(401).json(resMsg);
	}
});

routerUser.get("/encryption-key", async (_req, res) => {
	const resMsg: ResInterface = { status: 200, data: encryptionKey };
	res.status(200).json(resMsg);
});

routerUser.post("/create", async (req, res) => {
	const { useraccount, username, password, color, isAdmin, isCreator } = req.body;
	if (!(useraccount && username && password)) {
		const resContent: ResInterface = { status: 400, msg: "请求参数错误" };
		res.status(400).json(resContent);
		return;
	}
	if (isAdmin !== undefined && typeof isAdmin !== "boolean") {
		const resContent: ResInterface = { status: 400, msg: "isAdmin 参数类型错误" };
		res.status(400).json(resContent);
		return;
	}
	if (isCreator !== undefined && typeof isCreator !== "boolean") {
		const resContent: ResInterface = { status: 400, msg: "isCreator 参数类型错误" };
		res.status(400).json(resContent);
		return;
	}
	try {
		const user = await createUser(useraccount, username, password, "", color || undefined, isAdmin, isCreator);
		const resContent: ResInterface = { status: 200, msg: "创建成功", data: user };
		res.status(200).json(resContent);
	} catch (e: any) {
		const resContent: ResInterface = { status: 500, msg: e.message || "服务器处理错误" };
		res.status(500).json(resContent);
	}
});

routerUser.post("/update", async (req, res) => {
	const { id, username, password, color, isAdmin, isCreator } = req.body;
	if (!id) {
		const resContent: ResInterface = { status: 400, msg: "缺少用户ID" };
		res.status(400).json(resContent);
		return;
	}
	if (isAdmin !== undefined && typeof isAdmin !== "boolean") {
		const resContent: ResInterface = { status: 400, msg: "isAdmin 参数类型错误" };
		res.status(400).json(resContent);
		return;
	}
	if (isCreator !== undefined && typeof isCreator !== "boolean") {
		const resContent: ResInterface = { status: 400, msg: "isCreator 参数类型错误" };
		res.status(400).json(resContent);
		return;
	}
	try {
		const mapQuota = getMapQuota(req.body.mapQuota);
		const mapUploadSizeLimit = getMapUploadSizeLimit(req.body.mapUploadSizeLimit);
		const mapDailyUploadLimit = getMapDailyUploadLimit(req.body.mapDailyUploadLimit);
		const user = await updateUser(id, { username, password, color, isAdmin, isCreator, mapQuota, mapUploadSizeLimit, mapDailyUploadLimit });
		const resContent: ResInterface = { status: 200, msg: "更新成功", data: user };
		res.status(200).json(resContent);
	} catch (e: any) {
		const resContent: ResInterface = { status: 500, msg: e.message || "服务器处理错误" };
		res.status(500).json(resContent);
	}
});

routerUser.delete("/delete", async (req, res) => {
	const { id } = req.query;
	if (id) {
		try {
			const result = await deleteUser(id.toString());
			if (result?.deletedMaps) await deleteMapFiles(result.deletedMaps);
			const resMsg: ResInterface = { status: 200, msg: "删除成功", data: result };
			res.status(200).json(resMsg);
		} catch {
			const resMsg: ResInterface = { status: 500, msg: "数据库请求错误" };
			res.status(500).json(resMsg);
		}
	}
});

routerUser.post("/login", async (req, res) => {
	const { useraccount, password } = req.body;
	if (useraccount && password) {
		try {
			const user = await userLogin(useraccount, password, privateKey);
			const tokenExpireTimeMs = 30 * 60 * 1000;
			const token = await setToken(user.id, user.isAdmin, tokenExpireTimeMs);
			const refreshToken = await setRefreshToken(user.id, user.isAdmin);

			await AppDataSource.getRepository(User)
				.update({ id: user.id }, { online: true, lastActiveTime: new Date() });

			const resContent: ResInterface = { status: 200, msg: "登录成功", data: { token, refreshToken } };
			res.status(200).json(resContent);
		} catch (e: any) {
			const resContent: ResInterface = { status: 400, msg: e.message };
			res.status(400).json(resContent);
		}
	} else {
		const resContent: ResInterface = { status: 400, msg: "请求参数错误" };
		res.status(400).json(resContent);
	}
});

routerUser.post("/refresh-token", async (req, res) => {
	const { refreshToken } = req.body;
	if (!refreshToken) {
		const resContent: ResInterface = { status: 400, msg: "缺少 refreshToken" };
		res.status(400).json(resContent);
		return;
	}
	try {
		const tokenInfo = verifyToken(refreshToken, "refresh");
		if (!tokenInfo) {
			const resContent: ResInterface = { status: 401, msg: "refreshToken无效" };
			res.status(401).json(resContent);
			return;
		}
		const { userId, isAdmin } = tokenInfo;
		const tokenExpireTimeMs = 30 * 60 * 1000;
		const newToken = await setToken(userId, isAdmin, tokenExpireTimeMs);
		const newRefreshToken = await setRefreshToken(userId, isAdmin);

		await AppDataSource.getRepository(User)
			.update({ id: userId }, { online: true, lastActiveTime: new Date() });

		const resContent: ResInterface = {
			status: 200,
			msg: "刷新成功",
			data: { token: newToken, refreshToken: newRefreshToken },
		};
		res.status(200).json(resContent);
	} catch {
		const resContent: ResInterface = { status: 401, msg: "refreshToken过期或无效" };
		res.status(401).json(resContent);
	}
});

routerUser.post("/register", avatarMulter.single("avatar"), async (req, res) => {
	if (!req.file) {
		const resContent: ResInterface = { status: 400, msg: "头像上传异常" };
		res.status(400).json(resContent);
		return;
	}

	const { useraccount, username, password, color } = req.body;

	if (!(useraccount && username && password && color)) {
		await cleanupTempFiles([req.file]);
		const resContent: ResInterface = { status: 400, msg: "请求参数错误" };
		res.status(400).json(resContent);
		return;
	}

	try {
		const user = await withFileCleanup(
			{
				files: [{ file: req.file, targetPath: env("AVATAR_STORAGE_PATH", "user/avatars"), exts: [".png", ".jpg", ".jpeg"] }],
				name: randomString(16),
			},
			async (urls) => {
				return await createUser(useraccount, username, password, urls[0], color || undefined);
			},
		);
		const resContent: ResInterface = { status: 200, msg: "注册成功", data: user };
		res.status(200).json(resContent);
	} catch (e: any) {
		const resContent: ResInterface = { status: 500, msg: e.message || "服务器处理错误" };
		res.status(500).json(resContent);
	}
});