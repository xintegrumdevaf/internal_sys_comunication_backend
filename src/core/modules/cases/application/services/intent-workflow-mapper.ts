import { mapIntentToWorkflowType as fromCatalog } from "../../domain/intent-catalog";

/**
 * Mapeo intent → workflow_type (docs/spec/06_AI_PROMPTS.md §2 + 02_STATE_MACHINE.md §9).
 * Delega al catálogo canónico — no duplicar la lista aquí.
 */
export function mapIntentToWorkflowType(intent: string): string | null {
  return fromCatalog(intent);
}
