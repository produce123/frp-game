import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class AdminAuditLog {
	@PrimaryGeneratedColumn("uuid")
	id: string;

	@Index()
	@Column({ type: "varchar", length: 36, nullable: true })
	adminId: string | null;

	@Index()
	@Column({ type: "varchar", length: 36, nullable: true })
	targetUserId: string | null;

	@Column({ type: "varchar", length: 64, nullable: false })
	action: string;

	@Column({ type: "text", nullable: true })
	detail: string | null;

	@CreateDateColumn()
	createdAt: Date;
}