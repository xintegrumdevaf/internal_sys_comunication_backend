import type { Pool } from "pg";
import type {
  AuditRepositoryPort,
  AuditStats,
  AuditStatsFilter,
  ListAuditEventsFilter,
  RecordAuditEventInput,
} from "../../application/ports/audit.repository.port";
import type {
  AuditActorType,
  AuditCategory,
  AuditEvent,
} from "../../domain/audit-event.entity";
import type { AgentRole } from "../../../departments/domain/agent.entity";

type AuditRow = {
  id: string;
  action: string;
  category: AuditCategory;
  resource_type: string;
  resource_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_role: AgentRole | null;
  department_id: string | null;
  department_name: string | null;
  metadata: Record<string, unknown>;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  correlation_id: string | null;
  occurred_at: Date;
};

function mapRow(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    action: row.action,
    category: row.category ?? "operational",
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    actorType: row.actor_type ?? "agent",
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    departmentId: row.department_id,
    departmentName: row.department_name,
    metadata: row.metadata ?? {},
    beforeState: row.before_state,
    afterState: row.after_state,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
  };
}

export class AuditRepositoryPg implements AuditRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordAuditEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_event (
         action, category, resource_type, resource_id, actor_type,
         actor_id, department_id, metadata, before_state, after_state,
         ip_address, user_agent, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.action,
        input.category ?? "operational",
        input.resourceType,
        input.resourceId,
        input.actorType ?? "agent",
        input.actorId ?? null,
        input.departmentId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.beforeState ? JSON.stringify(input.beforeState) : null,
        input.afterState ? JSON.stringify(input.afterState) : null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.correlationId ?? null,
      ]
    );
  }

  async list(
    filterOrLimit: number | ListAuditEventsFilter
  ): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
    const filter: ListAuditEventsFilter =
      typeof filterOrLimit === "number" ? { limit: filterOrLimit } : filterOrLimit;

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    if (filter.action) {
      if (Array.isArray(filter.action)) {
        values.push(filter.action);
        whereClauses.push(`a.action = ANY($${values.length}::text[])`);
      } else {
        values.push(filter.action);
        whereClauses.push(`a.action = $${values.length}`);
      }
    }

    if (filter.category) {
      values.push(filter.category);
      whereClauses.push(`a.category = $${values.length}`);
    }

    if (filter.resourceType) {
      values.push(filter.resourceType);
      whereClauses.push(`a.resource_type = $${values.length}`);
    }

    if (filter.resourceId) {
      values.push(filter.resourceId);
      whereClauses.push(`a.resource_id = $${values.length}`);
    }

    if (filter.actorId) {
      values.push(filter.actorId);
      whereClauses.push(`a.actor_id = $${values.length}`);
    }

    if (filter.departmentId) {
      values.push(filter.departmentId);
      whereClauses.push(`a.department_id = $${values.length}`);
    } else if (filter.departmentIds && filter.departmentIds.length > 0) {
      values.push(filter.departmentIds);
      whereClauses.push(`a.department_id = ANY($${values.length}::uuid[])`);
    }

    if (filter.from) {
      values.push(filter.from);
      whereClauses.push(`a.occurred_at >= $${values.length}`);
    }

    if (filter.to) {
      values.push(filter.to);
      whereClauses.push(`a.occurred_at <= $${values.length}`);
    }

    if (filter.cursor) {
      values.push(new Date(filter.cursor));
      whereClauses.push(`a.occurred_at < $${values.length}`);
    }

    if (filter.search) {
      values.push(`%${filter.search}%`);
      whereClauses.push(`(
        a.action ILIKE $${values.length} OR 
        a.resource_id ILIKE $${values.length} OR 
        ag.name ILIKE $${values.length} OR 
        ag.email ILIKE $${values.length}
      )`);
    }

    values.push(limit + 1);
    const limitParam = values.length;

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const { rows } = await this.pool.query<AuditRow>(
      `SELECT 
         a.id,
         a.action,
         a.category,
         a.resource_type,
         a.resource_id,
         a.actor_type,
         a.actor_id,
         ag.name AS actor_name,
         ag.email AS actor_email,
         ag.role AS actor_role,
         a.department_id,
         d.name AS department_name,
         a.metadata,
         a.before_state,
         a.after_state,
         a.ip_address,
         a.user_agent,
         a.correlation_id,
         a.occurred_at
       FROM audit_event a
       LEFT JOIN agent ag ON ag.id = a.actor_id
       LEFT JOIN department d ON d.id = a.department_id
       ${whereSql}
       ORDER BY a.occurred_at DESC
       LIMIT $${limitParam}`,
      values
    );

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;

    const lastItem = slice[slice.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.occurred_at.toISOString() : null;

    return {
      events: slice.map(mapRow),
      nextCursor,
    };
  }

  async getStats(filter: AuditStatsFilter = {}): Promise<AuditStats> {
    const whereClauses: string[] = [];
    const values: unknown[] = [];

    if (filter.departmentId) {
      values.push(filter.departmentId);
      whereClauses.push(`department_id = $${values.length}`);
    } else if (filter.departmentIds && filter.departmentIds.length > 0) {
      values.push(filter.departmentIds);
      whereClauses.push(`department_id = ANY($${values.length}::uuid[])`);
    }

    if (filter.from) {
      values.push(filter.from);
      whereClauses.push(`occurred_at >= $${values.length}`);
    }

    if (filter.to) {
      values.push(filter.to);
      whereClauses.push(`occurred_at <= $${values.length}`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // 1. Total and by category
    const catQuery = await this.pool.query<{ category: AuditCategory; count: string }>(
      `SELECT category, COUNT(*) AS count
       FROM audit_event
       ${whereSql}
       GROUP BY category`,
      values
    );

    const byCategory: Record<AuditCategory, number> = {
      security: 0,
      operational: 0,
      data_change: 0,
      system: 0,
    };

    let totalEvents = 0;
    for (const r of catQuery.rows) {
      const cnt = Number.parseInt(r.count, 10) || 0;
      if (r.category in byCategory) {
        byCategory[r.category] = cnt;
      }
      totalEvents += cnt;
    }

    // 2. Top actions
    const actQuery = await this.pool.query<{ action: string; count: string }>(
      `SELECT action, COUNT(*) AS count
       FROM audit_event
       ${whereSql}
       GROUP BY action
       ORDER BY count DESC
       LIMIT 5`,
      values
    );

    const topActions = actQuery.rows.map((r) => ({
      action: r.action,
      count: Number.parseInt(r.count, 10) || 0,
    }));

    // 3. Top actors
    const actorQuery = await this.pool.query<{ actor_id: string; actor_name: string; count: string }>(
      `SELECT a.actor_id, COALESCE(ag.name, 'Sistema') AS actor_name, COUNT(*) AS count
       FROM audit_event a
       LEFT JOIN agent ag ON ag.id = a.actor_id
       ${whereSql}
       WHERE a.actor_id IS NOT NULL
       GROUP BY a.actor_id, ag.name
       ORDER BY count DESC
       LIMIT 5`,
      values
    );

    const topActors = actorQuery.rows.map((r) => ({
      actorId: r.actor_id,
      actorName: r.actor_name,
      count: Number.parseInt(r.count, 10) || 0,
    }));

    return {
      totalEvents,
      byCategory,
      topActions,
      topActors,
    };
  }
}
