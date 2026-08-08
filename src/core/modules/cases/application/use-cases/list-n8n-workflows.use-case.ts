import type { N8nWorkflowCategory, N8nWorkflowRegistryEntry } from "../../domain/n8n-workflow-registry-entry.entity";
import type { N8nWorkflowRegistryRepositoryPort } from "../ports/n8n-workflow-registry.repository.port";

/** docs/spec/03_API_CONTRACT.md §C.1 `GET /api/admin/n8n-workflows`. */
export class ListN8nWorkflowsUseCase {
  constructor(private readonly repo: N8nWorkflowRegistryRepositoryPort) {}

  async execute(filter?: { category?: N8nWorkflowCategory }): Promise<N8nWorkflowRegistryEntry[]> {
    return this.repo.list(filter);
  }
}
