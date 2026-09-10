import type { AuditActorType, AuditCategory } from "../../domain/audit-event.entity";
import type { AgentRole } from "../../../departments/domain/agent.entity";

export interface AuditEventDto {
  id: string;
  action: string;
  category: AuditCategory;
  resourceType: string;
  resourceId: string;
  actor: {
    id: string | null;
    name: string;
    email: string | null;
    role: AgentRole | null;
    type: AuditActorType;
  };
  department: {
    id: string;
    name: string;
  } | null;
  metadata: Record<string, unknown>;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string | null;
  occurredAt: string;
}

export interface AuditStatsDto {
  totalEvents: number;
  byCategory: Record<AuditCategory, number>;
  topActions: Array<{ action: string; count: number }>;
  topActors: Array<{ actorId: string; actorName: string; count: number }>;
}
