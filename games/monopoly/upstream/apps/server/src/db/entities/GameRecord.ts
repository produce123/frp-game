import { Entity, Column, PrimaryGeneratedColumn, PrimaryColumn, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

@Entity()
export class GameRecord {
	@PrimaryGeneratedColumn("uuid")
	id: string;

	@PrimaryColumn({ type: "varchar", nullable: false })
	name: string;

	@Column({ type: "int", nullable: false })
	duration: number;

	@Column({ type: "varchar", nullable: true })
	mapId: string | null;

	@Column({ type: "varchar", nullable: true })
	mapName: string | null;

	@Index()
	@CreateDateColumn({
		name: "create_time",
		nullable: true,
	})
	createTime: Date;

	@UpdateDateColumn({
		name: "update_time",
		nullable: true,
	})
	updateTime: Date | null;
}
