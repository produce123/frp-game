import fs from "fs/promises";
import { validateAndRename } from "./file-validation.js";
import { getStorage } from "./factory.js";
import { serverLog } from "#src/utils/logger";

export interface FileCleanupEntry {
	file: Express.Multer.File;
	targetPath: string;
	exts: string[];
}

export interface FileCleanupConfig {
	files: FileCleanupEntry[];
	name: string;
}

export async function cleanupTempFiles(files: Express.Multer.File[]): Promise<void> {
	for (const file of files) {
		try {
			await fs.unlink(file.path);
		} catch {
			// may already be deleted
		}
	}
}

export async function withFileCleanup<T>(
	config: FileCleanupConfig,
	callback: (urls: string[]) => Promise<T>,
): Promise<T> {
	const validatedFiles: { filePath: string; fileName: string; targetPath: string }[] = [];
	let uploadedKeys: string[] = [];

	try {
		for (const entry of config.files) {
			const result = await validateAndRename(config.name, entry.file, entry.exts);
			validatedFiles.push({ ...result, targetPath: entry.targetPath });
		}

		uploadedKeys = validatedFiles.map((f) => `${f.targetPath}/${f.fileName}`);

		const storage = getStorage();
		const urls = await storage.uploadMany(
			validatedFiles.map((f) => ({
				filePath: f.filePath,
				name: f.fileName,
				targetPath: f.targetPath,
			})),
		);

		return await callback(urls);
	} catch (error) {
		if (uploadedKeys.length > 0) {
			try {
				await getStorage().delete(uploadedKeys);
			} catch (cleanupErr: any) {
				serverLog(`Failed to rollback uploaded files: ${cleanupErr.message}`, "warn");
			}
		}
		throw error;
	} finally {
		for (const f of validatedFiles) {
			try {
				await fs.unlink(f.filePath);
			} catch {
				// temp file may already be moved or deleted
			}
		}
		// Also clean up original temp files if validateAndRename wasn't reached for them
		for (const entry of config.files) {
			try {
				await fs.unlink(entry.file.path);
			} catch {
				// may already be renamed or deleted
			}
		}
	}
}
