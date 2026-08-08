export interface WorkflowInstance {
  id: string;
  caseId: string;
  workflowType: string;
  /** p.ej. 'VALIDATE_CLIENT', 'WAITING_USER_DIAGNOSTIC' — docs/spec/02_STATE_MACHINE.md §3. */
  currentState: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
