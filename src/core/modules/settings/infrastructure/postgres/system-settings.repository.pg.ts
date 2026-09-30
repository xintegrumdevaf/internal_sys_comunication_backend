import type { Pool } from "pg";
import type { SystemSettingsRepositoryPort } from "../../application/ports/system-settings.repository.port";

export class SystemSettingsRepositoryPg implements SystemSettingsRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async get<T>(key: string): Promise<T | null> {
    const res = await this.pool.query<{ value: T }>(
      `SELECT value FROM system_setting WHERE key = $1 LIMIT 1`,
      [key],
    );
    if (res.rows.length === 0) return null;
    return res.rows[0]?.value ?? null;
  }

  async set<T>(key: string, value: T, description?: string, updatedBy?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO system_setting (key, value, description, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             description = COALESCE(EXCLUDED.description, system_setting.description),
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [key, JSON.stringify(value), description ?? null, updatedBy ?? null],
    );
  }

  async listAll(): Promise<Record<string, unknown>> {
    const res = await this.pool.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM system_setting ORDER BY key ASC`,
    );
    const result: Record<string, unknown> = {};
    for (const row of res.rows) {
      result[row.key] = row.value;
    }
    return result;
  }
}
