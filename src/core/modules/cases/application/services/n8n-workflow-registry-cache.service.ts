import type { N8nWorkflowRegistryEntry } from "../../domain/n8n-workflow-registry-entry.entity";
import type { N8nWorkflowRegistryRepositoryPort } from "../ports/n8n-workflow-registry.repository.port";

const DEFAULT_TTL_MS = 30_000;

/**
 * docs/spec/05_BUILD_PLAN.md Etapa 3 — "cache en memoria de corta duracion,
 * invalidada al escribir en la tabla". `N8nGatewayHttp` resuelve la URL de
 * cada accion a traves de este cache (nunca consulta Postgres en cada
 * llamada); los casos de uso admin (`UpsertN8nWorkflowUseCase`,
 * `DeactivateN8nWorkflowUseCase`) llaman `invalidate(action)` justo despues
 * de escribir, para que la siguiente llamada refleje el cambio sin reiniciar
 * el proceso.
 */
export class N8nWorkflowRegistryCache {
  private readonly cache = new Map<string, { entry: N8nWorkflowRegistryEntry; expiresAt: number }>();

  constructor(
    private readonly repo: N8nWorkflowRegistryRepositoryPort,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async resolve(action: string): Promise<N8nWorkflowRegistryEntry | null> {
    const cached = this.cache.get(action);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.entry;
    }

    const entry = await this.repo.findByAction(action);
    if (entry) {
      this.cache.set(action, { entry, expiresAt: Date.now() + this.ttlMs });
    } else {
      this.cache.delete(action);
    }
    return entry;
  }

  invalidate(action: string): void {
    this.cache.delete(action);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
