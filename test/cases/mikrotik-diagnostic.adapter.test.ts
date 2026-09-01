import { describe, expect, it, vi, beforeEach } from "vitest";
import { MikrotikDiagnosticAdapter } from "../../src/core/modules/cases/infrastructure/diagnostic/mikrotik-diagnostic.adapter";
import type { Logger } from "../../src/shared/logging/logger";

const mockLogger: Logger = {
  child: () => mockLogger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe("MikrotikDiagnosticAdapter", () => {
  const baseUrl = "http://mikrotik-test.local:3001/api";
  let adapter: MikrotikDiagnosticAdapter;

  beforeEach(() => {
    vi.restoreAllMocks();
    adapter = new MikrotikDiagnosticAdapter({
      baseUrl,
      timeoutMs: 1000,
      logger: mockLogger,
    });
  });

  it("ejecuta DIAGNOSTIC enviando payload correcto a /api/v1/diagnostic", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "WAITING_USER",
          question: "¿La luz LOS está en rojo?",
          diagnostic: "check_physical_fiber",
          technical: { olt: "santaBarbara", pon: "3" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await adapter.executeAction({
      action: "DIAGNOSTIC",
      caseId: "case-123",
      conversationId: "conv-456",
      correlationId: "corr-789",
      input: {
        sector: "santaBarbara",
        oltName: "santaBarbara",
        pon: "3",
        serial: "D011A66CB67C",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe("http://mikrotik-test.local:3001/api/v1/diagnostic");
    expect(JSON.parse(calledOptions?.body as string)).toEqual({
      sector: "santaBarbara",
      oltName: "santaBarbara",
      pon: "3",
      serial: "D011A66CB67C",
      conversationId: "conv-456",
    });

    expect(result).toEqual({
      success: true,
      result: {
        status: "WAITING_USER",
        question: "¿La luz LOS está en rojo?",
        diagnostic: "check_physical_fiber",
        technical: { olt: "santaBarbara", pon: "3" },
      },
    });
  });

  it("ejecuta CONTINUE_DIAGNOSTIC enviando conversationId y mensaje a /api/v1/diagnostic/continue", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "COMPLETED",
          diagnostic: "ONU_REBOOTED_OK",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await adapter.executeAction({
      action: "CONTINUE_DIAGNOSTIC",
      caseId: "case-123",
      conversationId: "conv-456",
      correlationId: "corr-789",
      input: {
        message: "Ya reinicié el equipo y la luz está verde",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe("http://mikrotik-test.local:3001/api/v1/diagnostic/continue");
    expect(JSON.parse(calledOptions?.body as string)).toEqual({
      conversationId: "conv-456",
      message: "Ya reinicié el equipo y la luz está verde",
    });

    expect(result).toEqual({
      success: true,
      result: {
        status: "COMPLETED",
        diagnostic: "ONU_REBOOTED_OK",
      },
    });
  });

  it("ejecuta CHECK_CLIENT_STATUS enviando sector e ip a /api/v1/mikrotik/client-status", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sector: "totoracocha",
          ip: "10.100.14.6",
          status: "CORTADO",
          clientName: "BERNAL LOJA LIDIA TARCILA",
          list: "CORTADO",
          creationTime: "2026-08-24 15:59:48",
          canBeReactivated: true,
          reason: "El cliente se encuentra Cortado en la lista 'CORTADO'.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await adapter.executeAction({
      action: "CHECK_CLIENT_STATUS",
      caseId: "case-123",
      conversationId: "conv-456",
      correlationId: "corr-789",
      input: {
        sector: "totoracocha",
        ip: "10.100.14.6",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe("http://mikrotik-test.local:3001/api/v1/mikrotik/client-status");
    expect(JSON.parse(calledOptions?.body as string)).toEqual({
      sector: "totoracocha",
      ip: "10.100.14.6",
    });

    expect(result).toEqual({
      success: true,
      result: {
        sector: "totoracocha",
        ip: "10.100.14.6",
        status: "CORTADO",
        clientName: "BERNAL LOJA LIDIA TARCILA",
        list: "CORTADO",
        creationTime: "2026-08-24 15:59:48",
        canBeReactivated: true,
        reason: "El cliente se encuentra Cortado en la lista 'CORTADO'.",
      },
    });
  });

  it("retorna VALIDATION_ERROR (non-retryable) cuando la API responde 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Faltan campos obligatorios", { status: 400 }),
    );

    const result = await adapter.executeAction({
      action: "DIAGNOSTIC",
      caseId: "case-123",
      conversationId: "conv-456",
      correlationId: "corr-789",
      input: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("retorna EXTERNAL_SERVICE_ERROR (retryable) cuando la API responde 500", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await adapter.executeAction({
      action: "DIAGNOSTIC",
      caseId: "case-123",
      conversationId: "conv-456",
      correlationId: "corr-789",
      input: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("EXTERNAL_SERVICE_ERROR");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("retorna TIMEOUT (retryable) cuando fetch es abortado por timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );

    const result = await adapter.executeAction({
      action: "DIAGNOSTIC",
      caseId: "case-123",
      conversationId: "conv-456",
      correlationId: "corr-789",
      input: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("retorna UNSUPPORTED cuando se le pide una accion no soportada", async () => {
    const result = await adapter.executeAction({
      action: "VALIDATE_CLIENT",
      caseId: "case-123",
      conversationId: "conv-456",
      correlationId: "corr-789",
      input: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("UNSUPPORTED");
      expect(result.error.retryable).toBe(false);
    }
  });
});
