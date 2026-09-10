import { describe, expect, it, vi } from "vitest";
import { CompositeActionGateway } from "../../src/core/modules/cases/infrastructure/gateways/composite-action-gateway";
import type { N8nGatewayPort } from "../../src/core/modules/cases/application/ports/n8n-gateway.port";

describe("CompositeActionGateway", () => {
  it("deriva DIAGNOSTIC y CONTINUE_DIAGNOSTIC al diagnosticGateway", async () => {
    const n8nGateway: N8nGatewayPort = {
      executeAction: vi.fn(),
    };
    const diagnosticGateway: N8nGatewayPort = {
      executeAction: vi.fn().mockResolvedValue({
        success: true,
        result: { status: "COMPLETED" },
      }),
    };

    const composite = new CompositeActionGateway({
      n8nGateway,
      diagnosticGateway,
    });

    const diagResult = await composite.executeAction({
      action: "DIAGNOSTIC",
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      input: { serial: "ABC" },
    });

    expect(diagnosticGateway.executeAction).toHaveBeenCalledTimes(1);
    expect(n8nGateway.executeAction).not.toHaveBeenCalled();
    expect(diagResult.success).toBe(true);

    const contResult = await composite.executeAction({
      action: "CONTINUE_DIAGNOSTIC",
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      input: { message: "ok" },
    });

    expect(diagnosticGateway.executeAction).toHaveBeenCalledTimes(2);
    expect(n8nGateway.executeAction).not.toHaveBeenCalled();
    expect(contResult.success).toBe(true);

    const clientStatusResult = await composite.executeAction({
      action: "CHECK_CLIENT_STATUS",
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      input: { sector: "totoracocha", ip: "10.100.14.6" },
    });

    expect(diagnosticGateway.executeAction).toHaveBeenCalledTimes(3);
    expect(n8nGateway.executeAction).not.toHaveBeenCalled();
    expect(clientStatusResult.success).toBe(true);
  });

  it("deriva el resto de acciones (VALIDATE_CLIENT, etc.) al n8nGateway", async () => {
    const n8nGateway: N8nGatewayPort = {
      executeAction: vi.fn().mockResolvedValue({
        success: true,
        result: { found: true },
      }),
    };
    const diagnosticGateway: N8nGatewayPort = {
      executeAction: vi.fn(),
    };

    const composite = new CompositeActionGateway({
      n8nGateway,
      diagnosticGateway,
    });

    const result = await composite.executeAction({
      action: "VALIDATE_CLIENT",
      caseId: "case-1",
      conversationId: "conv-1",
      correlationId: "corr-1",
      input: { id: "1234567890" },
    });

    expect(n8nGateway.executeAction).toHaveBeenCalledTimes(1);
    expect(diagnosticGateway.executeAction).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
