import { Entity, Column, PrimaryGeneratedColumn, PrimaryColumn, BeforeInsert, CreateDateColumn, Index } from "typeorm";
import { AppDataSource } from "#src/db/dbConnecter";

let hasAdmin = false;

@Entity()
export class User {
	@PrimaryGeneratedColumn("uuid")
	id: string;

	@PrimaryColumn({ type: "varchar", nullable: false })
	useraccount: string;

	@Column({ type: "varchar", nullable: false })
	username: string;

	@Column({ type: "varchar", nullable: false })
	password: string;

	@Column({ type: "varchar", nullable: false })
	salt: string;

	@Column({ type: "varchar", nullable: true })
	avatar: string;

	@Column({ type: "varchar", nullable: false })
	color: string;

	@Column({ type: "boolean", nullable: false, default: false })
	online: boolean;

	@Column({ type: "boolean", nullable: false, default: false })
	isAdmin: boolean;

	@Column({ type: "boolean", nullable: false, default: false })
	isCreator: boolean;

	@Column({ type: "int", nullable: true })
	mapQuota: number | null;

	/** 单次地图上传大小限制（单位 MB，null 表示使用默认值 50MB） */
	@Column({ type: "int", nullable: true })
	mapUploadSizeLimit: number | null;

	/** 每日地图上传次数上限（null 表示使用默认值 3 次/天） */
	@Column({ type: "int", nullable: true })
	mapDailyUploadLimit: number | null;

	/** 今日已上传次数（配合 todayUploadDate 使用，跨天时重置为 0） */
	@Column({ type: "int", nullable: false, default: 0 })
	todayUploadCount: number;

	/** 计数归属日期（YYYY-MM-DD），与当天不符时按 0 处理 */
	@Column({ type: "varchar", length: 10, nullable: true })
	todayUploadDate: string | null;

	@Index()
	@CreateDateColumn({ name: "create_time", nullable: true })
	createTime: Date;

	@Column({ type: "datetime", nullable: true, name: "last_active_time" })
	lastActiveTime: Date | null;

	@BeforeInsert()
	async setAdminStatus() {
		if (hasAdmin) return;
		const userRepository = AppDataSource.getRepository(User);
		const count = await userRepository.count();
		if (count === 0) {
			this.isAdmin = true;
			hasAdmin = true;
		}
	}
}