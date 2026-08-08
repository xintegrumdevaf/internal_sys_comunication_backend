import { describe, expect, it, vi } from "vitest";
import { N8nWorkflowRegistryCache } from "../../../src/core/modules/cases/application/services/n8n-workflow-registry-cache.service";
import { N8nWorkflowRegistryRepositoryFake } from "../fakes";

describe("N8nWorkflowRegistryCache (docs/spec/05_BUILD_PLAN.md Etapa 3)", () => {
  it("resuelve desde el repositorio solo una vez mientras el TTL no vence", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/check-balance" });
    const cache = new N8nWorkflowRegistryCache(repo, 10_000);

    const first = await cache.resolve("CHECK_BALANCE");
    const second = await cache.resolve("CHECK_BALANCE");

    expect(first?.url).toBe("https://n8n.example/check-balance");
    expect(second).toEqual(first);
    expect(repo.findByActionCallCount).toBe(1);
  });

  it("vuelve a consultar el repositorio despues de que vence el TTL", async () => {
    vi.useFakeTimers();
    try {
      const repo = new N8nWorkflowRegistryRepositoryFake();
      repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/check-balance" });
      const cache = new N8nWorkflowRegistryCache(repo, 1_000);

      await cache.resolve("CHECK_BALANCE");
      vi.advanceTimersByTime(1_500);
      await cache.resolve("CHECK_BALANCE");

      expect(repo.findByActionCallCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidate(action) fuerza a resolver de nuevo contra el repositorio sin esperar el TTL", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/v1" });
    const cache = new N8nWorkflowRegistryCache(repo, 60_000);

    const first = await cache.resolve("CHECK_BALANCE");
    expect(first?.url).toBe("https://n8n.example/v1");

    // Simula que un admin actualizo la URL via PUT /api/admin/n8n-workflows/:action.
    repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/v2" });
    cache.invalidate("CHECK_BALANCE");

    const second = await cache.resolve("CHECK_BALANCE");
    expect(second?.url).toBe("https://n8n.example/v2");
    expect(repo.findByActionCallCount).toBe(2);
  });

  it("una accion inexistente devuelve null y no se cachea", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    const cache = new N8nWorkflowRegistryCache(repo);

    const result = await cache.resolve("UNKNOWN_ACTION");

    expect(result).toBeNull();
  });
});
