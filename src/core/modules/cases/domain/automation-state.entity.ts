/**
 * docs/spec/02_STATE_MACHINE.md §1: independiente del status del caso.
 * `changedBy = null` significa que el cambio lo hizo el sistema, no un agente.
 */
export interface AutomationState {
  caseId: string;
  enabled: boolean;
  disabledReason: string | null;
  changedAt: Date;
  changedBy: string | null;
}
