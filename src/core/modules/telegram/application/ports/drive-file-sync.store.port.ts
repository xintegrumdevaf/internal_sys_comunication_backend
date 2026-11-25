import type { DriveFileSyncState } from "../../domain/drive-file-sync.entity";

export interface DriveFileSyncStorePort {
  getState(): Promise<DriveFileSyncState>;
  saveState(state: DriveFileSyncState): Promise<void>;
}
