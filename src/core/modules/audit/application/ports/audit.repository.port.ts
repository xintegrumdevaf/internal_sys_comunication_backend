import type {
  AuditActorType,
  AuditCategory,
  AuditEvent,
} from "../../domain/audit-event.entity";

export type RecordAuditEventInput = {
  action: string;
  category?: AuditCategory;
  resourceType: string;
  resourceId: string;
  actorType?: AuditActorType;
  actorId?: string | null;
  departmentId?: string | null;
  metadata?: Record<string, unknown>;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
};

export type ListAuditEventsFilter = {
  action?: string | string[];
  category?: AuditCategory;
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  departmentId?: string;
  departmentIds?: string[];
  from?: Date;
  to?: Date;
  search?: string;
  limit?: number;
  cursor?: string;
};

export type AuditStatsFilter = {
  departmentId?: string;
  departmentIds?: string[];
  from?: Date;
  to?: Date;
};

export type AuditStats = {
  totalEvents: number;
  byCategory: Record<AuditCategory, number>;
  topActions: Array<{ action: string; count: number }>;
  topActors: Array<{ actorId: string; actorName: string; count: number }>;
};

export interface AuditRepositoryPort {
  /**
   * AGENTS.md no-negociable: "toda accion de escritura queda en audit_event".
   */
  record(input: RecordAuditEventInput): Promise<void>;
  list(filterOrLimit: number | ListAuditEventsFilter): Promise<{ events: AuditEvent[]; nextCursor: string | null }>;
  getStats(filter?: AuditStatsFilter): Promise<AuditStats>;
}
