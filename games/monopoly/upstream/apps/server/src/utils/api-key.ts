import { RequestHandler } from "express";
import { getActiveMapKeyByKey } from "#src/db/api/map-key";
import { getTodayUploadCount, incrementTodayUploadCount } from "#src/db/api/map-upload-counter";
import { countGameMapsByCreator } from "#src/db/api/game-map";
import { verToken } from "#src/utils/token";
import { ResInterface } from "#src/interfaces/res";
import { User } from "#src/db/entities/User";

export interface ApiKeyUser {
	userId: string;
	username: string;
	quota: number | null;
	user: User;
}

export interface ApiKeyRequest {
	apiKeyUser?: ApiKeyUser;
}

export const apiKeyAuth: RequestHandler = async (req, res, next) => {
	const header = req.header("X-Api-Key");
	const key = Array.isArray(header) ? header[0] : header;
	if (!key) {
		const resContent: ResInterface = { status: 401, msg: "缺少 X-Api-Key" };
		res.status(401).json(resContent);
		return;
	}

	try {
		const mapKey = await getActiveMapKeyByKey(key);
		if (!mapKey || !mapKey.user) {
			const resContent: ResInterface = { status: 401, msg: "API Key 无效或已吊销" };
			res.status(401).json(resContent);
			return;
		}
		if (!mapKey.user.isCreator) {
			const resContent: ResInterface = { status: 403, msg: "该用户不是创作者，上传权限已收回" };
			res.status(403).json(resContent);
			return;
		}
		(req as typeof req & ApiKeyRequest).apiKeyUser = {
			userId: mapKey.userId,
			username: mapKey.user.username,
			quota: mapKey.user.mapQuota,
			user: mapKey.user,
		};
		next();
	} catch (e: any) {
		const resContent: ResInterface = { status: 500, msg: e.message || "API Key 校验失败" };
		res.status(500).json(resContent);
	}
};

export function getApiKeyUser(req: unknown): ApiKeyUser {
	const user = (req as ApiKeyRequest).apiKeyUser;
	if (!user) throw new Error("API Key 用户不存在");
	return user;
}

export function getUserIdFromToken(token?: string): string | null {
	if (!token) return null;
	const info = verToken(token);
	return info?.userId || null;
}

export async function getApiKeyInfo(user: ApiKeyUser) {
	const used = await countGameMapsByCreator(user.userId);
	return {
		username: user.username,
		quota: user.quota,
		used,
		// 上传大小限制（MB，null 表示使用默认 50MB）
		uploadSizeLimit: user.user.mapUploadSizeLimit ?? null,
		// 每日上传次数限制（null 表示使用默认 3 次/天）
		dailyUploadLimit: user.user.mapDailyUploadLimit ?? null,
		// 今日已上传次数（跨天自动归零）
		todayUploaded: getTodayUploadCount(user.user),
	};
}