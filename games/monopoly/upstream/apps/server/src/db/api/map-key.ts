import crypto from "crypto";
import { IsNull } from "typeorm";
import { AppDataSource } from "#src/db/dbConnecter";
import { MapKey } from "#src/db/entities/MapKey";
import { User } from "#src/db/entities/User";

const mapKeyRepository = AppDataSource.getRepository(MapKey);
const userRepository = AppDataSource.getRepository(User);

export function createPlainMapKey() {
	return `mk_${crypto.randomBytes(32).toString("base64url")}`;
}

export const getActiveMapKeyByKey = async (key: string) => {
	return await mapKeyRepository.findOne({
		where: { key, revokedAt: IsNull() },
		relations: { user: true },
	});
};

export const getMapKeyByUserId = async (userId: string) => {
	return await mapKeyRepository.findOne({ where: { userId } });
};

export const getActiveMapKeyByUserId = async (userId: string) => {
	return await mapKeyRepository.findOne({ where: { userId, revokedAt: IsNull() } });
};

export const generateMapKeyForUser = async (userId: string) => {
	const user = await userRepository.findOneBy({ id: userId });
	if (!user) throw new Error("用户不存在");

	const existing = await getMapKeyByUserId(userId);
	if (existing && !existing.revokedAt) {
		const error = new Error("该用户已有可用 key");
		(error as any).statusCode = 409;
		throw error;
	}

	const entity = existing || new MapKey();
	entity.userId = userId;
	entity.key = createPlainMapKey();
	entity.revokedAt = null;
	return await mapKeyRepository.save(entity);
};

export const resetMapKeyForUser = async (userId: string) => {
	const user = await userRepository.findOneBy({ id: userId });
	if (!user) throw new Error("用户不存在");
	const existing = await getMapKeyByUserId(userId);
	const entity = existing || new MapKey();
	entity.userId = userId;
	entity.key = createPlainMapKey();
	entity.revokedAt = null;
	return await mapKeyRepository.save(entity);
};

export const revokeMapKeyForUser = async (userId: string) => {
	const existing = await getActiveMapKeyByUserId(userId);
	if (!existing) return null;
	existing.revokedAt = new Date();
	return await mapKeyRepository.save(existing);
};