import type { Pool } from "pg";
import type { AuditRepositoryPort, RecordAuditEventInput } from "../../application/ports/audit.repository.port";
import type { AuditEvent } from "../../domain/audit-event.entity";

function mapRow(row: {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  metadata: Record<string, unknown>;
  actor_id: string | null;
  occurred_at: Date;
}): AuditEvent {
  return {
    id: row.id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: row.metadata,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
  };
}

export class AuditRepositoryPg implements AuditRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordAuditEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_event (action, resource_type, resource_id, metadata, actor_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.action, input.resourceType, input.resourceId, input.metadata ?? {}, input.actorId ?? null],
    );
  }

  async list(limit: number): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM audit_event ORDER BY occurred_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(mapRow);
  }
}
