import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { User } from "#src/db/entities/User";

@Entity()
export class MapKey {
	@PrimaryGeneratedColumn("uuid")
	id: string;

	@Index({ unique: true })
	@Column({ type: "varchar", length: 36, nullable: false })
	userId: string;

	@ManyToOne(() => User, { nullable: false, onDelete: "CASCADE" })
	@JoinColumn({ name: "userId", referencedColumnName: "id" })
	user: User;

	@Index({ unique: true })
	@Column({ type: "varchar", length: 128, nullable: false })
	key: string;

	@Column({ type: "datetime", nullable: true })
	revokedAt: Date | null;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}