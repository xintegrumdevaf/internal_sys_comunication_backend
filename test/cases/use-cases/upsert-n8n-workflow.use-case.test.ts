import { describe, expect, it } from "vitest";
import { UpsertN8nWorkflowUseCase } from "../../../src/core/modules/cases/application/use-cases/upsert-n8n-workflow.use-case";
import { N8nWorkflowRegistryCache } from "../../../src/core/modules/cases/application/services/n8n-workflow-registry-cache.service";
import { N8nWorkflowRegistryRepositoryFake } from "../fakes";
import { silentLogger } from "../../support/silent-logger";

function buildUseCase(repo: N8nWorkflowRegistryRepositoryFake, cache: N8nWorkflowRegistryCache) {
  return new UpsertN8nWorkflowUseCase({
    repo,
    cache,
    logger: silentLogger,
    defaultTimeoutMs: 8000,
    defaultMaxRetries: 2,
  });
}

describe("UpsertN8nWorkflowUseCase (docs/spec/03_API_CONTRACT.md §C.2)", () => {
  it("crea una accion nueva con los defaults globales cuando no se especifican timeoutMs/maxRetries", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    const cache = new N8nWorkflowRegistryCache(repo);
    const useCase = buildUseCase(repo, cache);

    const entry = await useCase.execute({
      action: "RECORD_PAYMENT",
      url: "https://n8n.example/record-payment",
      updatedBy: "admin-1",
    });

    expect(entry).toMatchObject({
      action: "RECORD_PAYMENT",
      category: "case_action",
      timeoutMs: 8000,
      maxRetries: 2,
      active: true,
    });
  });

  it("actualiza la URL de una accion existente preservando category/timeoutMs no especificados", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    repo.seed({
      action: "CHECK_BALANCE",
      category: "case_action",
      url: "https://n8n.example/v1",
      timeoutMs: 5000,
      maxRetries: 1,
    });
    const cache = new N8nWorkflowRegistryCache(repo);
    const useCase = buildUseCase(repo, cache);

    const entry = await useCase.execute({
      action: "CHECK_BALANCE",
      url: "https://n8n.example/v2",
      updatedBy: "admin-1",
    });

    expect(entry).toMatchObject({
      url: "https://n8n.example/v2",
      category: "case_action",
      timeoutMs: 5000,
      maxRetries: 1,
    });
  });

  it("invalida el cache para que la siguiente llamada resuelva la URL nueva sin reiniciar el proceso", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/v1" });
    const cache = new N8nWorkflowRegistryCache(repo, 60_000);
    const useCase = buildUseCase(repo, cache);

    await cache.resolve("CHECK_BALANCE"); // precalienta el cache con la URL vieja
    await useCase.execute({ action: "CHECK_BALANCE", url: "https://n8n.example/v2", updatedBy: "admin-1" });

    const resolved = await cache.resolve("CHECK_BALANCE");
    expect(resolved?.url).toBe("https://n8n.example/v2");
  });

  it("rechaza una URL de test (/webhook-test/...) — nunca URL de produccion", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    const cache = new N8nWorkflowRegistryCache(repo);
    const useCase = buildUseCase(repo, cache);

    await expect(
      useCase.execute({
        action: "CHECK_BALANCE",
        url: "https://n8n.example/webhook-test/check-balance",
        updatedBy: "admin-1",
      }),
    ).rejects.toMatchObject({ type: "VALIDATION_ERROR" });
  });
});
