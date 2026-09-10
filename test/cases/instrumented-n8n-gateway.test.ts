import { describe, expect, it } from "vitest";
import { InstrumentedN8nGateway } from "../../src/core/modules/cases/application/gateway/instrumented-n8n-gateway";
import { N8nGatewayFake, WorkflowExecutionRepositoryFake } from "./fakes";
import { silentLogger } from "../support/silent-logger";

describe("InstrumentedN8nGateway (docs/spec/03_API_CONTRACT.md §B)", () => {
  it("un reintento con el mismo input no vuelve a llamar al gateway real (idempotencyKey estable)", async () => {
    const executionRepo = new WorkflowExecutionRepositoryFake();
    const gateway = new N8nGatewayFake({
      RECORD_PAYMENT: () => ({ success: true, result: { recorded: true } }),
    });
    const instrumented = new InstrumentedN8nGateway(gateway, executionRepo, "wi-1", silentLogger);

    const params = {
      action: "RECORD_PAYMENT",
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      input: { amount: 10, reference: "ABC" },
    };

    const first = await instrumented.executeAction(params);
    const second = await instrumented.executeAction(params);

    expect(first).toEqual(second);
    expect(gateway.calls).toHaveLength(1); // el segundo intento no vuelve a tocar el gateway real
    expect(executionRepo.startedCallCount).toBe(1);

    // docs/spec/03_API_CONTRACT.md §B: el gateway real (N8nGatewayHttp) necesita
    // idempotencyKey/executionId para incluirlos en el body del POST a n8n.
    const forwardedParams = gateway.calls[0]!;
    expect(forwardedParams.idempotencyKey).toBeTruthy();
    expect(forwardedParams.executionId).toBeTruthy();
  });

  it("registra el error estructurado cuando el gateway real falla", async () => {
    const executionRepo = new WorkflowExecutionRepositoryFake();
    const gateway = new N8nGatewayFake({
      DIAGNOSTIC: () => ({
        success: false,
        error: { type: "EXTERNAL_SERVICE_ERROR", message: "MikroTik timeout", retryable: true },
      }),
    });
    const instrumented = new InstrumentedN8nGateway(gateway, executionRepo, "wi-2", silentLogger);

    const result = await instrumented.executeAction({
      action: "DIAGNOSTIC",
      caseId: "case-2",
      conversationId: "conv-2",
      correlationId: "corr-2",
      input: { sector: "pomasqui" },
    });

    expect(result).toEqual({
      success: false,
      error: { type: "EXTERNAL_SERVICE_ERROR", message: "MikroTik timeout", retryable: true },
    });
    const execution = [...executionRepo.executions.values()][0]!;
    expect(execution.status).toBe("FAILED");
  });

  it("un reintento tras fallo vuelve a invocar al gateway real (no cachea errores)", async () => {
    const executionRepo = new WorkflowExecutionRepositoryFake();
    let attempts = 0;
    const gateway = new N8nGatewayFake({
      CHECK_BALANCE: () => {
        attempts += 1;
        if (attempts === 1) {
          return { success: false, error: { type: "EXTERNAL_SERVICE_ERROR", message: "Timeout temporal", retryable: true } };
        }
        return { success: true, result: { hasDebt: false, debt: 0 } };
      },
    });
    const instrumented = new InstrumentedN8nGateway(gateway, executionRepo, "wi-3", silentLogger);
    const params = {
      action: "CHECK_BALANCE",
      caseId: "case-3",
      conversationId: "conv-3",
      correlationId: "corr-3",
      input: { id: "12345" },
    };

    const first = await instrumented.executeAction(params);
    expect(first.success).toBe(false);

    // Segundo intento tras resolverse el error externo:
    const second = await instrumented.executeAction(params);
    expect(second.success).toBe(true);
    expect(gateway.calls).toHaveLength(2);
  });
});
