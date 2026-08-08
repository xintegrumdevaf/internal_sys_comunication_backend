import { validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { N8nWorkflowRegistryEntry } from "../../domain/n8n-workflow-registry-entry.entity";
import type { N8nWorkflowRegistryRepositoryPort } from "../ports/n8n-workflow-registry.repository.port";
import type { N8nWorkflowRegistryCache } from "../services/n8n-workflow-registry-cache.service";

export type UpsertN8nWorkflowInput = {
  action: string;
  url: string;
  timeoutMs?: number;
  maxRetries?: number;
  active?: boolean;
  updatedBy: string;
};

export type UpsertN8nWorkflowDeps = {
  repo: N8nWorkflowRegistryRepositoryPort;
  cache: N8nWorkflowRegistryCache;
  logger: Logger;
  /** Defaults globales (env.N8N_CALL_TIMEOUT_MS/MAX_RETRIES) para una accion nueva sin valor propio todavia. */
  defaultTimeoutMs: number;
  defaultMaxRetries: number;
};

/**
 * docs/spec/03_API_CONTRACT.md §C.2 `PUT /api/admin/n8n-workflows/:action`.
 * Crea o actualiza una entrada sin redeploy; invalida el cache inmediatamente
 * despues de escribir para que la siguiente llamada a esa accion use la URL
 * nueva sin reiniciar el proceso (docs/spec/05_BUILD_PLAN.md, criterio de
 * aceptacion de la Etapa 3).
 */
export class UpsertN8nWorkflowUseCase {
  constructor(private readonly deps: UpsertN8nWorkflowDeps) {}

  async execute(input: UpsertN8nWorkflowInput): Promise<N8nWorkflowRegistryEntry> {
    if (input.url.includes("/webhook-test/")) {
      throw validationError(
        "La URL de un workflow de n8n debe ser de produccion — /webhook-test/... no esta permitido (docs/spec/00_OVERVIEW.md §3.6)",
      );
    }

    const existing = await this.deps.repo.findByAction(input.action);

    const entry = await this.deps.repo.upsert({
      action: input.action,
      url: input.url,
      category: existing?.category ?? "case_action",
      description: existing?.description ?? null,
      timeoutMs: input.timeoutMs ?? existing?.timeoutMs ?? this.deps.defaultTimeoutMs,
      maxRetries: input.maxRetries ?? existing?.maxRetries ?? this.deps.defaultMaxRetries,
      active: input.active ?? existing?.active ?? true,
      updatedBy: input.updatedBy,
    });

    this.deps.cache.invalidate(input.action);
    this.deps.logger.info(
      { action: input.action, url: input.url, updatedBy: input.updatedBy, wasNew: !existing },
      "catalogo de n8n actualizado",
    );

    return entry;
  }
}
