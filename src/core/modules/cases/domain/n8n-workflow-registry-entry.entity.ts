/**
 * docs/spec/01_DATA_MODEL.md §2 + docs/spec/04_N8N_WORKFLOW_SPEC.md §6 —
 * catalogo accion -> URL de n8n, editable en caliente sin redeploy.
 *
 * - `case_action`: paso de un `WorkflowDefinition`, lo invoca el motor de
 *   workflow de un `Case` (ej. `VALIDATE_CLIENT`, `DIAGNOSTIC`).
 * - `admin_action`: herramienta administrativa (ej. ingesta de documentos al
 *   RAG) que el motor de workflow de un caso NUNCA invoca.
 */
export type N8nWorkflowCategory = "case_action" | "admin_action";

export interface N8nWorkflowRegistryEntry {
  action: string;
  category: N8nWorkflowCategory;
  url: string;
  description: string | null;
  timeoutMs: number;
  maxRetries: number;
  active: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}
