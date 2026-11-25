import type { SystemSettingsRepositoryPort } from "../../../settings/application/ports/system-settings.repository.port";
import type { DriveFileSyncStorePort } from "../../application/ports/drive-file-sync.store.port";
import type { DriveFileSyncState } from "../../domain/drive-file-sync.entity";

const DRIVE_FILE_SYNC_KEY = "drive.file_sync";

/**
 * Almacena el último estado de sincronización de archivos de Google Drive dentro
 * de la tabla `system_settings` para mantener persistencia ante reinicios.
 */
export class SystemSettingsDriveFileSyncStore implements DriveFileSyncStorePort {
  constructor(private readonly settingsRepo: SystemSettingsRepositoryPort) {}

  async getState(): Promise<DriveFileSyncState> {
    const stored = await this.settingsRepo.get<Partial<DriveFileSyncState>>(DRIVE_FILE_SYNC_KEY);
    if (!stored || typeof stored !== "object" || !stored.records) {
      return { updatedAt: null, records: {} };
    }
    return {
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
      records: stored.records,
    };
  }

  async saveState(state: DriveFileSyncState): Promise<void> {
    await this.settingsRepo.set(
      DRIVE_FILE_SYNC_KEY,
      state,
      "Estado de última modificación de archivos monitoreados en Google Drive",
    );
  }
}
