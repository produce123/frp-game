/** 地图上传大小限制默认值（单位 MB）。用户未单独配置（mapUploadSizeLimit 为空）时使用 */
export const DEFAULT_MAP_UPLOAD_SIZE_LIMIT_MB = 50;

/** 每日地图上传次数默认上限。用户未单独配置（mapDailyUploadLimit 为空）时使用 */
export const DEFAULT_MAP_UPLOAD_DAILY_LIMIT = 3;

/** 计算实际生效的上传大小限制（字节）。user.mapUploadSizeLimit 为空时回落到默认值 */
export function resolveUploadSizeLimitBytes(user: { mapUploadSizeLimit?: number | null }): number {
	const mb = user.mapUploadSizeLimit ?? DEFAULT_MAP_UPLOAD_SIZE_LIMIT_MB;
	return mb * 1024 * 1024;
}
