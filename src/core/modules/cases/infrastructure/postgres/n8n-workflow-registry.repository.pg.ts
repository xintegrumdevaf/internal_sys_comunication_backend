import type { Pool } from "pg";
import type { N8nWorkflowCategory, N8nWorkflowRegistryEntry } from "../../domain/n8n-workflow-registry-entry.entity";
import type {
  N8nWorkflowRegistryRepositoryPort,
  UpsertN8nWorkflowRegistryInput,
} from "../../application/ports/n8n-workflow-registry.repository.port";

type Row = {
  action: string;
  category: N8nWorkflowCategory;
  url: string;
  description: string | null;
  timeout_ms: number;
  max_retries: number;
  active: boolean;
  updated_at: Date;
  updated_by: string | null;
};

function mapRow(row: Row): N8nWorkflowRegistryEntry {
  return {
    action: row.action,
    category: row.category,
    url: row.url,
    description: row.description,
    timeoutMs: row.timeout_ms,
    maxRetries: row.max_retries,
    active: row.active,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export class N8nWorkflowRegistryRepositoryPg implements N8nWorkflowRegistryRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async findByAction(action: string): Promise<N8nWorkflowRegistryEntry | null> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM n8n_workflow_registry WHERE action = $1`, [action]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async list(filter?: { category?: N8nWorkflowCategory }): Promise<N8nWorkflowRegistryEntry[]> {
    if (filter?.category) {
      const { rows } = await this.pool.query<Row>(
        `SELECT * FROM n8n_workflow_registry WHERE category = $1 ORDER BY action`,
        [filter.category],
      );
      return rows.map(mapRow);
    }
    const { rows } = await this.pool.query<Row>(`SELECT * FROM n8n_workflow_registry ORDER BY action`);
    return rows.map(mapRow);
  }

  async upsert(input: UpsertN8nWorkflowRegistryInput): Promise<N8nWorkflowRegistryEntry> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO n8n_workflow_registry (action, category, url, description, timeout_ms, max_retries, active, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (action) DO UPDATE SET
         category = EXCLUDED.category,
         url = EXCLUDED.url,
         description = EXCLUDED.description,
         timeout_ms = EXCLUDED.timeout_ms,
         max_retries = EXCLUDED.max_retries,
         active = EXCLUDED.active,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [
        input.action,
        input.category,
        input.url,
        input.description,
        input.timeoutMs,
        input.maxRetries,
        input.active,
        input.updatedBy,
      ],
    );
    return mapRow(rows[0]!);
  }
}
