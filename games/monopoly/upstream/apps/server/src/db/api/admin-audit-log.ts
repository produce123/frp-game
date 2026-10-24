import { AppDataSource } from "#src/db/dbConnecter";
import { AdminAuditLog } from "#src/db/entities/AdminAuditLog";

const adminAuditLogRepository = AppDataSource.getRepository(AdminAuditLog);

export const createAdminAuditLog = async (info: {
	adminId?: string | null;
	targetUserId?: string | null;
	action: string;
	detail?: string | null;
}) => {
	const log = new AdminAuditLog();
	log.adminId = info.adminId || null;
	log.targetUserId = info.targetUserId || null;
	log.action = info.action;
	log.detail = info.detail || null;
	return await adminAuditLogRepository.save(log);
};