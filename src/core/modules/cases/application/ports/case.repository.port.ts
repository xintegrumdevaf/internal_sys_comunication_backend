import type { Case, CaseStatus } from "../../domain/case.entity";
import type { CaseContext } from "../../domain/contexts/case-context";
import type { WorkflowInstance } from "../../domain/workflow-instance.entity";
import type { AutomationState } from "../../domain/automation-state.entity";

export type CaseAggregate = {
  case: Case;
  workflowInstance: WorkflowInstance;
};

export type CreateCaseInput = {
  conversationId: string;
  workflowType: string;
  departmentId: string | null;
  context: CaseContext;
  initialState: string;
  expiresAt: Date | null;
};

/**
 * Actualizacion optimista (docs/spec/01_DATA_MODEL.md §3): `expectedCaseVersion`
 * y `expectedWorkflowVersion` deben coincidir con la fila actual o la
 * implementacion debe lanzar (0 rows affected -> conflicto, reintento a nivel
 * de aplicacion).
 */
export type ApplyCaseTransitionInput = {
  caseId: string;
  expectedCaseVersion: number;
  expectedWorkflowVersion: number;
  status: CaseStatus;
  context: CaseContext;
  currentState: string;
  /** `undefined` = no tocar la columna; se pasa explicito en cada llamada relevante. */
  departmentId?: string | null;
  expiresAt: Date | null;
};

export interface CaseRepositoryPort {
  create(input: CreateCaseInput): Promise<CaseAggregate>;

  findById(caseId: string): Promise<CaseAggregate | null>;

  /** Invariante: a lo sumo un caso por conversacion en ACTIVE/WAITING_USER. */
  findActiveByConversation(conversationId: string): Promise<CaseAggregate | null>;

  findPausedByConversationAndType(
    conversationId: string,
    workflowType: string,
  ): Promise<CaseAggregate | null>;

  listByConversation(conversationId: string): Promise<Case[]>;

  listAutomatableExpiring(now: Date): Promise<Case[]>;

  applyTransition(input: ApplyCaseTransitionInput): Promise<CaseAggregate>;

  setAssignedAgent(caseId: string, agentId: string | null): Promise<void>;

  getAutomationState(caseId: string): Promise<AutomationState | null>;

  setAutomationEnabled(
    caseId: string,
    enabled: boolean,
    options: { reason?: string | null; changedBy?: string | null },
  ): Promise<AutomationState>;

  appendEvent(caseId: string, type: string, payload: Record<string, unknown>): Promise<void>;
}
