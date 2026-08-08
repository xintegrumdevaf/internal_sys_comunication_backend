import type { AuditEvent } from "../../domain/audit-event.entity";

export type RecordAuditEventInput = {
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  actorId?: string | null;
};

export interface AuditRepositoryPort {
  /**
   * AGENTS.md no-negociable: "toda accion de escritura queda en audit_event".
   */
  record(input: RecordAuditEventInput): Promise<void>;
  list(limit: number): Promise<AuditEvent[]>;
}
