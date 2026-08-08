import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { N8nWorkflowRegistryEntry } from "../../domain/n8n-workflow-registry-entry.entity";
import type { N8nWorkflowRegistryRepositoryPort } from "../ports/n8n-workflow-registry.repository.port";
import type { N8nWorkflowRegistryCache } from "../services/n8n-workflow-registry-cache.service";

export type DeactivateN8nWorkflowDeps = {
  repo: N8nWorkflowRegistryRepositoryPort;
  cache: N8nWorkflowRegistryCache;
  logger: Logger;
};

/**
 * docs/spec/03_API_CONTRACT.md §C.2 `DELETE /api/admin/n8n-workflows/:action`
 * — "Desactiva una entrada del catalogo": nunca borra la fila (se conserva
 * `url`/`description`/historial), solo `active = false` para que
 * `N8nGatewayHttp` la rechace como no disponible.
 */
export class DeactivateN8nWorkflowUseCase {
  constructor(private readonly deps: DeactivateN8nWorkflowDeps) {}

  async execute(input: { action: string; updatedBy: string }): Promise<N8nWorkflowRegistryEntry> {
    const existing = await this.deps.repo.findByAction(input.action);
    if (!existing) {
      throw notFound(`No existe una entrada de n8n_workflow_registry para la accion '${input.action}'`);
    }

    const entry = await this.deps.repo.upsert({
      action: existing.action,
      url: existing.url,
      category: existing.category,
      description: existing.description,
      timeoutMs: existing.timeoutMs,
      maxRetries: existing.maxRetries,
      active: false,
      updatedBy: input.updatedBy,
    });

    this.deps.cache.invalidate(input.action);
    this.deps.logger.warn({ action: input.action, updatedBy: input.updatedBy }, "entrada del catalogo de n8n desactivada");

    return entry;
  }
}
