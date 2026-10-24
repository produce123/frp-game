import { AppDataSource } from "#src/db/dbConnecter";
import { User } from "#src/db/entities/User";

const userRepository = AppDataSource.getRepository(User);

/** 服务器本地日期（YYYY-MM-DD） */
export function getTodayDateString() {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** 今日已上传次数：计数归属日期不是今天时按 0 处理（跨天自动重置） */
export function getTodayUploadCount(user: Pick<User, "todayUploadCount" | "todayUploadDate">): number {
	return user.todayUploadDate === getTodayDateString() ? user.todayUploadCount : 0;
}

/**
 * 今日上传次数 +1。跨天时重置计数。单次 save 完成，避免读改写窗口扩大。
 * 并发窗口极小且每日限流为软限制，偶发并发放宽可接受（不影响资金安全）。
 */
export async function incrementTodayUploadCount(user: User) {
	const today = getTodayDateString();
	if (user.todayUploadDate === today) {
		user.todayUploadCount = (user.todayUploadCount || 0) + 1;
	} else {
		user.todayUploadDate = today;
		user.todayUploadCount = 1;
	}
	await userRepository.save(user);
}

/** 重置今日上传计数（管理端手动重置，不影响已保存的配置） */
export async function resetTodayUploadCountForUser(userId: string) {
	await userRepository.update({ id: userId }, { todayUploadDate: null, todayUploadCount: 0 });
}
