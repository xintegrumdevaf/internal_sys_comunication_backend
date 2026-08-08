import type { CaseContext } from "./contexts/case-context";

export type CaseStatus =
  | "NEW"
  | "ACTIVE"
  | "WAITING_USER"
  | "PAUSED"
  | "ESCALATED"
  | "HUMAN_ACTIVE"
  | "COMPLETED"
  | "EXPIRED"
  | "CANCELLED";

/**
 * docs/spec/02_STATE_MACHINE.md §1. `department_id`/`assigned_agent_id` son
 * nullable: un caso puede no tener departamento resuelto todavia (pool de
 * triage, §10) y puede no estar reclamado por ningun agente (bandeja
 * compartida, 01_DATA_MODEL.md §7).
 */
export interface Case {
  id: string;
  conversationId: string;
  departmentId: string | null;
  assignedAgentId: string | null;
  workflowType: string;
  status: CaseStatus;
  context: CaseContext;
  version: number;
  lastActivityAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Estados en los que un caso puede ser el `active_case_id` de su conversacion. */
export const ACTIVATABLE_CASE_STATUSES: CaseStatus[] = ["ACTIVE", "WAITING_USER"];

/** Estados desde los que se puede pausar/escalar/cancelar (automatizables, §1). */
export const AUTOMATABLE_CASE_STATUSES: CaseStatus[] = ["NEW", "ACTIVE", "WAITING_USER", "PAUSED"];

export const TERMINAL_CASE_STATUSES: CaseStatus[] = ["COMPLETED", "EXPIRED", "CANCELLED"];
