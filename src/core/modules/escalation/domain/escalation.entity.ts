/**
 * docs/spec/01_DATA_MODEL.md — `escalation.department_id` nullable = pool de triage
 * (02_STATE_MACHINE.md §10). `summary` = estructura de 03_API_CONTRACT.md §D.
 */
export type EscalationPriority = "low" | "normal" | "high" | "urgent";
export type EscalationStatus = "PENDING" | "ASSIGNED" | "RESOLVED";

export type EscalationSummary = {
  problem: string;
  workflow: string | null;
  department: string | null;
  status: string;
  reason: string;
  completedSteps: string[];
  results: Record<string, unknown>;
  pendingAction: string;
  timeline: Array<{ action: string; status: string; at: string }>;
  readableSummary?: string;
};

export interface Escalation {
  id: string;
  caseId: string;
  departmentId: string | null;
  priority: EscalationPriority;
  reason: string;
  summary: EscalationSummary;
  status: EscalationStatus;
  assignedAgentId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}
