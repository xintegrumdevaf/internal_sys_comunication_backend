import type { AgentRole } from "../../departments/domain/agent.entity";

export type AuditCategory = "security" | "operational" | "data_change" | "system";

export type AuditActorType = "agent" | "system" | "customer" | "external_api";

export interface AuditEvent {
  id: string;
  action: string;
  category: AuditCategory;
  resourceType: string;
  resourceId: string;
  actorType: AuditActorType;
  actorId: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  actorRole?: AgentRole | null;
  departmentId: string | null;
  departmentName?: string | null;
  metadata: Record<string, unknown>;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string | null;
  occurredAt: Date;
}
