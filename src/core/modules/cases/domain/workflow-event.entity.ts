/** Catalogo de `type` en docs/spec/03_API_CONTRACT.md §E. */
export interface WorkflowEvent {
  id: string;
  caseId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}
