import type { CaseContext } from "../../domain/contexts/case-context";
import type { N8nGatewayPort } from "../ports/n8n-gateway.port";

/**
 * Resultado de ejecutar un paso del motor (docs/spec/02_STATE_MACHINE.md §1-3).
 * Nunca es un `if` suelto en el motor: cada `WorkflowStateHandler` devuelve
 * exactamente uno de estos, y quien orquesta (`AdvanceCaseUseCase`) decide
 * como persistirlo — el handler no toca repositorios.
 */
export type WorkflowStepOutcome =
  | { type: "CONTINUE"; nextState: string; context: CaseContext }
  | { type: "WAITING_USER"; nextState: string; context: CaseContext }
  | { type: "COMPLETED"; context: CaseContext }
  | { type: "ESCALATED"; reason: string; context: CaseContext };

export type WorkflowStepInput = {
  caseId: string;
  conversationId: string;
  correlationId: string;
  /** Estado actual de `workflow_instance.current_state` antes de este paso. */
  currentState: string;
  context: CaseContext;
  gateway: N8nGatewayPort;
  /**
   * Texto crudo del cliente que disparo este avance (unidad de trabajo del
   * buffer, docs/spec/02_STATE_MACHINE.md §12). Algunos pasos lo reenvian tal
   * cual a n8n en vez de una version reinterpretada (ej. `CONTINUE_DIAGNOSTIC`,
   * docs/spec/04_N8N_WORKFLOW_SPEC.md §7.2) — `undefined` cuando el avance no
   * fue disparado por un mensaje nuevo (ej. reintento interno).
   */
  text?: string;
};

export type WorkflowStateHandler = (input: WorkflowStepInput) => Promise<WorkflowStepOutcome>;

export interface WorkflowDefinition {
  workflowType: string;
  initialState: string;
  /** docs/spec/02_STATE_MACHINE.md §8 — configurable por workflow_type, nunca hardcodeado en el motor. */
  expirationHours: number;
  states: Record<string, WorkflowStateHandler>;
}
