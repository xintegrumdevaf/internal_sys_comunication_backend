import { afterEach, describe, expect, it, vi } from "vitest";
import { N8nGatewayHttp } from "../../../src/core/modules/cases/infrastructure/n8n/n8n-gateway.http";
import { N8nWorkflowRegistryCache } from "../../../src/core/modules/cases/application/services/n8n-workflow-registry-cache.service";
import { N8nWorkflowRegistryRepositoryFake } from "../fakes";
import { silentLogger } from "../../support/silent-logger";

const BASE_PARAMS = {
  action: "CHECK_BALANCE",
  caseId: "case-1",
  conversationId: "conv-1",
  correlationId: "corr-1",
  idempotencyKey: "case-1:CHECK_BALANCE:hash",
  executionId: "exec-1",
  input: { nationalId: "123" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("N8nGatewayHttp (docs/spec/03_API_CONTRACT.md §B, Etapa 3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("exige idempotencyKey/executionId ya calculados (debe invocarse via InstrumentedN8nGateway)", async () => {
    const repo = new N8nWorkflowRegistryRepositoryFake();
    const cache = new N8nWorkflowRegistryCache(repo);
    const gateway = new N8nGatewayHttp(cache, "internal-key", silentLogger);

    await expect(gateway.executeAction({ ...BASE_PARAMS, idempotencyKey: undefined })).rejects.toThrow(
      /idempotencyKey/,
    );
  });

  it("responde UNSUPPORTED sin llamar HTTP si la accion no esta en el catalogo o esta inactiva", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const repo = new N8nWorkflowRegistryRepositoryFake();
    repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/check-balance", active: false });
    const cache = new N8nWorkflowRegistryCache(repo);
    const gateway = new N8nGatewayHttp(cache, "internal-key", silentLogger);

    const result = await gateway.executeAction(BASE_PARAMS);

    expect(result).toEqual({
      success: false,
      error: { type: "UNSUPPORTED", message: expect.stringContaining("CHECK_BALANCE"), retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hace POST sincrono a la URL resuelta del catalogo con el header X-Internal-Api-Key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: { hasDebt: false } }));
    vi.stubGlobal("fetch", fetchMock);
    const repo = new N8nWorkflowRegistryRepositoryFake();
    repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/check-balance" });
    const cache = new N8nWorkflowRegistryCache(repo);
    const gateway = new N8nGatewayHttp(cache, "internal-key", silentLogger);

    const result = await gateway.executeAction(BASE_PARAMS);

    expect(result).toEqual({ success: true, result: { hasDebt: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://n8n.example/check-balance");
    expect(options.headers["X-Internal-Api-Key"]).toBe("internal-key");
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      correlationId: "corr-1",
      executionId: "exec-1",
      idempotencyKey: "case-1:CHECK_BALANCE:hash",
      caseId: "case-1",
      conversationId: "conv-1",
      input: { nationalId: "123" },
    });
  });

  it(
    "clasifica un timeout como TIMEOUT/retryable y reintenta hasta maxRetries con el mismo idempotencyKey",
    async () => {
      // Timeouts reales pero pequenos (evita el deadlock conocido entre fake
      // timers y AbortController): cada intento nunca responde y se aborta
      // por el timeoutMs configurado en el catalogo.
      const fetchMock = vi.fn().mockImplementation((_url: string, options: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const repo = new N8nWorkflowRegistryRepositoryFake();
      repo.seed({ action: "DIAGNOSTIC", url: "https://n8n.example/diagnostic", timeoutMs: 20, maxRetries: 2 });
      const cache = new N8nWorkflowRegistryCache(repo);
      const gateway = new N8nGatewayHttp(cache, "internal-key", silentLogger);

      const result = await gateway.executeAction({ ...BASE_PARAMS, action: "DIAGNOSTIC" });

      expect(result).toEqual({
        success: false,
        error: { type: "TIMEOUT", message: expect.stringContaining("20ms"), retryable: true },
      });
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 intento inicial + maxRetries(2)
      // Mismo idempotencyKey en cada intento — nunca uno nuevo por reintento.
      for (const call of fetchMock.mock.calls) {
        const body = JSON.parse(call[1].body);
        expect(body.idempotencyKey).toBe("case-1:CHECK_BALANCE:hash");
      }
    },
    10000,
  );

  it("un error no retryable no dispara reintento", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          success: false,
          error: { type: "BUSINESS_ERROR", message: "cliente sin contrato", retryable: false },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const repo = new N8nWorkflowRegistryRepositoryFake();
    repo.seed({ action: "CHECK_BALANCE", url: "https://n8n.example/check-balance", maxRetries: 3 });
    const cache = new N8nWorkflowRegistryCache(repo);
    const gateway = new N8nGatewayHttp(cache, "internal-key", silentLogger);

    const result = await gateway.executeAction(BASE_PARAMS);

    expect(result).toEqual({
      success: false,
      error: { type: "BUSINESS_ERROR", message: "cliente sin contrato", retryable: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
