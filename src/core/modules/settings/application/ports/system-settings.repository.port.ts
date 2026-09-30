export interface SystemSettingsRepositoryPort {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, description?: string, updatedBy?: string): Promise<void>;
  listAll(): Promise<Record<string, unknown>>;
}
