import { User } from "#src/db/entities/User";
import { AppDataSource } from "#src/db/dbConnecter";
import { Brackets } from "typeorm";
import { decryptPassword, generatePasswordHash, getRandomString, randomColor } from "#src/utils";
import { getActiveMapKeyByUserId, revokeMapKeyForUser } from "#src/db/api/map-key";
import { getTodayDateString } from "#src/db/api/map-upload-counter";
import { countGameMapsByCreator, detachPublishedMapsAndRemoveDraftsByCreator } from "#src/db/api/game-map";

const userRepository = AppDataSource.getRepository(User);

export const createUser = async (
	useraccount: string,
	username: string,
	password: string,
	avatar: string,
	color?: string,
	isAdmin?: boolean,
	isCreator?: boolean
) => {
	const accountRegex = /^[a-zA-Z0-9_]{3,20}$/;
	if (!accountRegex.test(useraccount)) {
		throw new Error("账号需为3-20位的字母、数字或下划线");
	}
	if (username.length < 1 || username.length > 20) {
		throw new Error("用户名长度需在1-20位之间");
	}
	const user = await AppDataSource.manager.findOneBy(User, { useraccount });
	if (user) throw new Error("已经存在的账号名");
	const decryptedPassword = decryptPassword(password);
	if (decryptedPassword.length < 6) {
		throw new Error("密码长度不能少于6位");
	}
	const { salt, passwordHash } = generatePasswordHash(decryptedPassword, getRandomString(16));

	const userToCreate = new User();
	userToCreate.useraccount = useraccount;
	userToCreate.username = username;
	userToCreate.password = passwordHash;
	userToCreate.salt = salt;
	userToCreate.avatar = avatar;
	userToCreate.color = color || randomColor();
	userToCreate.mapQuota = isCreator ? 1 : null;
	userToCreate.mapUploadSizeLimit = null;
	userToCreate.mapDailyUploadLimit = null;
	userToCreate.isCreator = isCreator ?? false;
	if (isAdmin !== undefined) {
		userToCreate.isAdmin = isAdmin;
	}

	return await userRepository.save(userToCreate);
};

export const userLogin = async (useraccount: string, password: string, privateKey: string) => {
	const user = await AppDataSource.manager.findOneBy(User, { useraccount });
	if (user) {
		const decryptedPassword = decryptPassword(password);
		if (!decryptedPassword) throw new Error("客户端密码解密失败");
		const { passwordHash } = generatePasswordHash(decryptedPassword, user.salt);
		if (user.password === passwordHash) {
			return user;
		} else {
			throw new Error("密码错误");
		}
	} else {
		throw new Error("不存在的账号");
	}
};

export const updateUser = async (
	id: string,
	data: { username?: string; password?: string; color?: string; isAdmin?: boolean; isCreator?: boolean; mapQuota?: number | null; mapUploadSizeLimit?: number | null; mapDailyUploadLimit?: number | null }
) => {
	const user = await userRepository.findOneBy({ id });
	if (!user) throw new Error("用户不存在");

	if (data.username !== undefined) {
		if (data.username.length < 1 || data.username.length > 20) {
			throw new Error("用户名长度需在1-20位之间");
		}
		user.username = data.username;
	}
	if (data.color !== undefined) user.color = data.color;
	if (data.isAdmin !== undefined) user.isAdmin = data.isAdmin;
	if (data.isCreator !== undefined) {
		user.isCreator = data.isCreator;
		// 关闭创作者身份：级联清空配额并吊销 key，彻底收回上传能力
		if (!data.isCreator) {
			user.mapQuota = null;
			user.mapUploadSizeLimit = null;
			user.mapDailyUploadLimit = null;
			await revokeMapKeyForUser(id);
		} else if (user.mapQuota === null) {
			// 开启创作者且未开通配额时，默认给予 1 个地图配额
			user.mapQuota = 1;
		}
	}
	if (data.mapQuota !== undefined && user.isCreator) {
		if (data.mapQuota !== null && (!Number.isInteger(data.mapQuota) || data.mapQuota < 0)) {
			throw new Error("地图配额必须为空或非负整数");
		}
		user.mapQuota = data.mapQuota;
	}
	if (data.mapUploadSizeLimit !== undefined && user.isCreator) {
		if (data.mapUploadSizeLimit !== null && (!Number.isInteger(data.mapUploadSizeLimit) || data.mapUploadSizeLimit < 1)) {
			throw new Error("上传大小限制必须为空或正整数（单位 MB）");
		}
		user.mapUploadSizeLimit = data.mapUploadSizeLimit;
	}
	if (data.mapDailyUploadLimit !== undefined && user.isCreator) {
		if (data.mapDailyUploadLimit !== null && (!Number.isInteger(data.mapDailyUploadLimit) || data.mapDailyUploadLimit < 1)) {
			throw new Error("每日上传次数限制必须为空或正整数");
		}
		user.mapDailyUploadLimit = data.mapDailyUploadLimit;
	}
	if (data.password) {
		const decryptedPassword = decryptPassword(data.password);
		if (decryptedPassword.length < 6) throw new Error("密码长度不能少于6位");
		const { salt, passwordHash } = generatePasswordHash(decryptedPassword, getRandomString(16));
		user.password = passwordHash;
		user.salt = salt;
	}
	return await userRepository.save(user);
};

export const deleteUser = async (id: string) => {
	const user = await userRepository.findOne({
		where: { id },
	});
	if (!user) return null;

	await revokeMapKeyForUser(id);
	const deletedMaps = await detachPublishedMapsAndRemoveDraftsByCreator(id);
	const removedUser = await userRepository.remove(user);
	return { user: removedUser, deletedMaps };
};

/** 数据迁移：将存量已开通配额（mapQuota 非空）的用户标记为创作者，保证已有上传能力不丢 */
export const migrateCreatorFlags = async () => {
	await userRepository
		.createQueryBuilder()
		.update(User)
		.set({ isCreator: true })
		.where("mapQuota IS NOT NULL AND isCreator = :isCreator", { isCreator: false })
		.execute();
};

export const getUserById = async (userId: string) => {
	const user = await AppDataSource.manager.findOne(User, {
		select: ["id", "useraccount", "username", "avatar", "color", "isCreator", "mapQuota", "mapUploadSizeLimit", "mapDailyUploadLimit"],
		where: { id: userId },
	});
	if (user) {
		return user;
	} else {
		return null;
	}
};

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
	const sortFieldMap = {
		createTime: "user.createTime",
		lastActiveTime: "user.lastActiveTime",
		username: "user.username",
		useraccount: "user.useraccount",
	} as const;

	const queryBuilder = userRepository
		.createQueryBuilder("user")
		.select([
			"user.id AS id",
			"user.useraccount AS useraccount",
			"user.username AS username",
			"user.avatar AS avatar",
			"user.color AS color",
			"user.online AS online",
			"user.isAdmin AS isAdmin",
			"user.isCreator AS isCreator",
			"user.mapQuota AS mapQuota",
			"user.mapUploadSizeLimit AS mapUploadSizeLimit",
			"user.mapDailyUploadLimit AS mapDailyUploadLimit",
			"user.todayUploadCount AS todayUploadCount",
			"user.todayUploadDate AS todayUploadDate",
			"DATE_FORMAT(user.createTime, '%Y-%m-%d %H:%i:%s') AS createTime",
			"CASE WHEN user.lastActiveTime IS NULL THEN NULL ELSE DATE_FORMAT(user.lastActiveTime, '%Y-%m-%d %H:%i:%s') END AS lastActiveTime",
		]);

	if (options?.search) {
		queryBuilder.andWhere(
			new Brackets((qb) => {
				qb.where("user.username LIKE :search", { search: `%${options.search}%` }).orWhere(
					"user.useraccount LIKE :search",
					{ search: `%${options.search}%` }
				);
			})
		);
	}

	if (options?.online !== undefined) {
		queryBuilder.andWhere("user.online = :online", { online: options.online });
	}

	if (options?.isAdmin !== undefined) {
		queryBuilder.andWhere("user.isAdmin = :isAdmin", { isAdmin: options.isAdmin });
	}

	if (options?.isCreator !== undefined) {
		queryBuilder.andWhere("user.isCreator = :isCreator", { isCreator: options.isCreator });
	}

	const sortBy = options?.sortBy && sortFieldMap[options.sortBy] ? options.sortBy : "createTime";
	const sortOrder = options?.sortOrder === "ASC" ? "ASC" : "DESC";

	const total = await queryBuilder.getCount();
	const rawUserList = await queryBuilder
		.orderBy(sortFieldMap[sortBy], sortOrder)
		.addOrderBy("user.useraccount", "ASC")
		.skip((page - 1) * size)
		.take(size)
		.getRawMany();

	const userList = await Promise.all(rawUserList.map(async (user) => {
		const key = await getActiveMapKeyByUserId(user.id);
		const mapCount = await countGameMapsByCreator(user.id);
		return {
			id: user.id,
			useraccount: user.useraccount,
			username: user.username,
			avatar: user.avatar,
			color: user.color,
			online: user.online === true || user.online === 1 || user.online === "1",
			isAdmin: user.isAdmin === true || user.isAdmin === 1 || user.isAdmin === "1",
			isCreator: user.isCreator === true || user.isCreator === 1 || user.isCreator === "1",
			mapQuota: user.mapQuota === null || user.mapQuota === undefined ? null : Number(user.mapQuota),
			mapUploadSizeLimit: user.mapUploadSizeLimit === null || user.mapUploadSizeLimit === undefined ? null : Number(user.mapUploadSizeLimit),
			mapDailyUploadLimit: user.mapDailyUploadLimit === null || user.mapDailyUploadLimit === undefined ? null : Number(user.mapDailyUploadLimit),
			todayUploaded: user.todayUploadDate === getTodayDateString() ? Number(user.todayUploadCount) || 0 : 0,
			mapKey: key?.key || null,
			mapCount,
			createTime: user.createTime || null,
			lastActiveTime: user.lastActiveTime || null,
		};
	}));

	return { userList, total };
};