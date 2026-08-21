import { describe, expect, it } from "vitest";
import { CaseSummaryBuilderService } from "../../src/core/modules/escalation/application/services/case-summary-builder.service";
import type { Case } from "../../src/core/modules/cases/domain/case.entity";
import type { WorkflowExecution } from "../../src/core/modules/cases/domain/workflow-execution.entity";

function baseCase(overrides: Partial<Case> = {}): Case {
  return {
    id: "case-1",
    conversationId: "conv-1",
    departmentId: "dept-support",
    assignedAgentId: null,
    workflowType: "SUPPORT_INTERNET",
    status: "ESCALATED",
    context: { workflowType: "SUPPORT_INTERNET", data: {} },
    version: 1,
    lastActivityAt: new Date(),
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function completedExecution(action: string, output: Record<string, unknown>): WorkflowExecution {
  return {
    id: `exec-${action}`,
    workflowInstanceId: "wf-1",
    caseId: "case-1",
    action,
    status: "COMPLETED",
    input: {},
    output,
    error: null,
    idempotencyKey: `case-1:${action}:x`,
    correlationId: "corr-1",
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

describe("CaseSummaryBuilderService — telemetria ONU en el resumen de escalacion", () => {
  it("aplana el bloque 'technical' crudo del microservicio de diagnostico a nombres entendibles", () => {
    const service = new CaseSummaryBuilderService();
    const summary = service.build({
      caseEntity: baseCase(),
      reason: "Diagnostico no resoluble automaticamente",
      executions: [
        completedExecution("DIAGNOSTIC", {
          diagnostic: "onu_offline",
          technical: {
            brand: "v-sol",
            onu: { id: 1, serial: "D011A66CB67C", model: "V2802R" },
            state: { runState: "down", adminState: "enable" },
            power: -29.4,
            mac: { mac: "AA:BB:CC:DD:EE:FF" },
            _history: [{ command: "show onu" }],
            failedStep: null,
          },
        }),
      ],
    });

    expect(summary.results.technical).toEqual({
      brand: "v-sol",
      onuModel: "V2802R",
      onuSerial: "D011A66CB67C",
      macAddress: "AA:BB:CC:DD:EE:FF",
      opticalPowerDbm: -29.4,
      runState: "down",
      adminState: "enable",
      onuId: 1,
    });
    // El ruido interno del microservicio (_history/failedStep) nunca llega al agente.
    expect(summary.results).not.toHaveProperty("_history");
    expect(summary.results).not.toHaveProperty("failedStep");
  });

  it("descarta 'technical' del resumen si no trajo ningun dato util", () => {
    const service = new CaseSummaryBuilderService();
    const summary = service.build({
      caseEntity: baseCase(),
      reason: "ONU no encontrada",
      executions: [
        completedExecution("DIAGNOSTIC", {
          diagnostic: "onu_not_found",
          technical: { onu: null, state: null, mac: null },
        }),
      ],
    });

    expect(summary.results).not.toHaveProperty("technical");
  });

  it("no rompe el resumen cuando ninguna ejecucion trae 'technical' (otros workflows)", () => {
    const service = new CaseSummaryBuilderService();
    const summary = service.build({
      caseEntity: baseCase({ workflowType: "BILLING_BALANCE" }),
      reason: "Requiere validar comprobante",
      executions: [completedExecution("CHECK_BALANCE", { hasDebt: true, debt: 45.5 })],
    });

    expect(summary.results).not.toHaveProperty("technical");
    expect(summary.results.hasDebt).toBe(true);
  });
});
