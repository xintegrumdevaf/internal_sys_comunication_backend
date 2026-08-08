import type { N8nWorkflowCategory, N8nWorkflowRegistryEntry } from "../../domain/n8n-workflow-registry-entry.entity";

export type UpsertN8nWorkflowRegistryInput = {
  action: string;
  category: N8nWorkflowCategory;
  url: string;
  description: string | null;
  timeoutMs: number;
  maxRetries: number;
  active: boolean;
  updatedBy: string | null;
};

/**
 * docs/spec/03_API_CONTRACT.md §C.1/§C.2 — persistencia del catalogo de
 * acciones de n8n. La logica de "que valor por defecto usar si el admin no
 * especifico uno" vive en el caso de uso (`UpsertN8nWorkflowUseCase`), nunca
 * aqui: este puerto solo persiste el registro que ya le llega resuelto.
 */
export interface N8nWorkflowRegistryRepositoryPort {
  findByAction(action: string): Promise<N8nWorkflowRegistryEntry | null>;
  list(filter?: { category?: N8nWorkflowCategory }): Promise<N8nWorkflowRegistryEntry[]>;
  upsert(input: UpsertN8nWorkflowRegistryInput): Promise<N8nWorkflowRegistryEntry>;
}
