import { describe, expect, it } from "vitest";
import { DeactivateN8nWorkflowUseCase } from "../../../src/core/modules/cases/application/use-cases/deactivate-n8n-workflow.use-case";
import { N8nWorkflowRegistryCache } from "../../../src/core/modules/cases/application/services/n8n-workflow-registry-cache.service";
import { N8nWorkflowRegistryRepositoryFake } from "../fakes";
import { silentLogger } from "../../support/silent-logger";

describe("DeactivateN8nWorkflowUseCase (docs/spec/03_API_CONTRACT.md §C.2 DELETE)", () => {
  it("desactiva la entrada sin borrar la fila (conserva url/category)", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/check-balance", category: "case_action" });
    const cache = new N8nWorkflowRegistryCache(repo);
    const useCase = new DeactivateN8nWorkflowUseCase({ repo, cache, logger: silentLogger });

    const entry = await useCase.execute({ action: "CHECK_BALANCE", updatedBy: "admin-1" });

    expect(entry).toMatchObject({
      action: "CHECK_BALANCE",
      url: "https://n8n.example/check-balance",
      category: "case_action",
      active: false,
    });
  });

  it("invalida el cache tras desactivar", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/check-balance" });
    const cache = new N8nWorkflowRegistryCache(repo, 60_000);
    const useCase = new DeactivateN8nWorkflowUseCase({ repo, cache, logger: silentLogger });

    await cache.resolve("CHECK_BALANCE");
    await useCase.execute({ action: "CHECK_BALANCE", updatedBy: "admin-1" });

    const resolved = await cache.resolve("CHECK_BALANCE");
    expect(resolved?.active).toBe(false);
  });

  it("lanza NOT_FOUND si la accion no existe en el catalogo", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    const cache = new N8nWorkflowRegistryCache(repo);
    const useCase = new DeactivateN8nWorkflowUseCase({ repo, cache, logger: silentLogger });

    await expect(useCase.execute({ action: "UNKNOWN", updatedBy: "admin-1" })).rejects.toMatchObject({
      type: "NOT_FOUND",
    });
  });
});
