import { AppDataSource } from "#src/db/dbConnecter";
import { GameRecord } from "#src/db/entities/GameRecord";

const gameRecordRepository = AppDataSource.getRepository(GameRecord);

export async function createRecord(
	name: string,
	duration: number,
	mapId?: string | null,
	mapName?: string | null,
) {
	const gameRecord = new GameRecord();
	gameRecord.name = name;
	gameRecord.duration = duration;
	gameRecord.mapId = mapId ?? null;
	gameRecord.mapName = mapName ?? null;

	return await gameRecordRepository.save(gameRecord);
}
