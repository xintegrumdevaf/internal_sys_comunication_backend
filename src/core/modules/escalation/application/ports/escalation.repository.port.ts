import type {
  Escalation,
  EscalationPriority,
  EscalationStatus,
  EscalationSummary,
} from "../../domain/escalation.entity";

export type CreateEscalationInput = {
  caseId: string;
  departmentId: string | null;
  priority?: EscalationPriority;
  reason: string;
  summary: EscalationSummary;
  assignedAgentId?: string | null;
};

export type ListEscalationsFilter = {
  departmentId?: string | null;
  status?: EscalationStatus;
  /** Pool sin departamento (02_STATE_MACHINE.md §10). */
  triage?: boolean;
};

export interface EscalationRepositoryPort {
  create(input: CreateEscalationInput): Promise<Escalation>;
  findById(id: string): Promise<Escalation | null>;
  findByCaseId(caseId: string): Promise<Escalation | null>;
  list(filter: ListEscalationsFilter): Promise<Escalation[]>;
  updateAssignment(
    id: string,
    input: {
      assignedAgentId: string | null;
      status: EscalationStatus;
      departmentId?: string | null;
    },
  ): Promise<Escalation>;
}
