export interface AuditEvent {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  actorId: string | null;
  occurredAt: Date;
}
