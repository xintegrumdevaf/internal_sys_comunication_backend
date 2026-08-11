import type { CaseContext } from "../../domain/contexts/case-context";
import type { ConversationIdentityPort } from "../../../customers/application/ports/conversation-identity.port";
import type { N8nGatewayPort } from "../ports/n8n-gateway.port";
import type { WaitingStep } from "./waiting-step";

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
  /** Entities de la interpretacion actual (02_STATE_MACHINE.md §13). */
  entities?: Record<string, unknown>;
  /**
   * Identidad validada en la conversación (02_STATE_MACHINE.md §14).
   * Opcional en tests unitarios de un solo paso; AdvanceCase lo inyecta siempre.
   */
  identity?: ConversationIdentityPort;
};

export type WorkflowStateHandler = (input: WorkflowStepInput) => Promise<WorkflowStepOutcome>;

export interface WorkflowDefinition {
  workflowType: string;
  initialState: string;
  /** docs/spec/02_STATE_MACHINE.md §8 — configurable por workflow_type, nunca hardcodeado en el motor. */
  expirationHours: number;
  states: Record<string, WorkflowStateHandler>;
  /**
   * Declaracion §13 de cada estado WAITING_* (requireAll/requireAny/maxAttempts).
   */
  waitingSteps?: Record<string, WaitingStep>;
  /**
   * Plantillas de respuesta de negocio por clave de estado/outcome
   * (docs/spec/02_STATE_MACHINE.md §12). Variables: `{{clave}}` desde result/context.
   */
  replyTemplates?: Record<string, string>;
}
