import { describe, it, expect } from "vitest";
import pino from "pino";
import type { Logger } from "../../../src/shared/logging/logger";
import { TriggerCaseDiagnosticUseCase } from "../../../src/core/modules/cases/application/use-cases/trigger-case-diagnostic.use-case";
import { CaseRepositoryFake } from "../fakes";
import type { N8nGatewayPort } from "../../../src/core/modules/cases/application/ports/n8n-gateway.port";

const silentLogger = pino({ level: "silent" }) as unknown as Logger;

describe("TriggerCaseDiagnosticUseCase", () => {
  it("ejecuta DIAGNOSTIC exitosamente y guarda la telemetría en el contexto del caso", async () => {
    const caseRepo = new CaseRepositoryFake();
    const created = await caseRepo.create({
      conversationId: "conv-diag-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-1",
      initialState: "DIAGNOSTIC",
      expiresAt: null,
      context: {
        workflowType: "SUPPORT_INTERNET",
        data: {
          contract: {
            id: "1001",
            sector: "pomasqui",
            oltName: "bicentenario",
            pon: "3",
            serial: "D011A66CB67C",
          },
        },
      },
    });

    const actionGateway: N8nGatewayPort = {
      async executeAction(req) {
        expect(req.action).toBe("DIAGNOSTIC");
        expect(req.input).toEqual({
          sector: "pomasqui",
          oltName: "bicentenario",
          pon: "3",
          serial: "D011A66CB67C",
          conversationId: "conv-diag-1",
        });

        return {
          success: true,
          result: {
            workflow: { status: "completed" },
            diagnostic: { status: "ONLINE_OK", findings: [] },
            technical: {
              brand: "Huawei",
              power: -19.45,
              mac: "AA:BB:CC:DD:EE:FF",
            },
          },
        };
      },
    };

    const useCase = new TriggerCaseDiagnosticUseCase({
      caseRepo,
      actionGateway,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      caseId: created.case.id,
      agentUserId: "00000000-0000-0000-0000-000000000001",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.technical).toMatchObject({
      brand: "Huawei",
      opticalPowerDbm: -19.45,
    });

    const saved = await caseRepo.findById(created.case.id);
    const savedData = (saved?.case.context?.data ?? {}) as Record<string, unknown>;
    const savedDiagnostic = savedData.diagnostic as Record<string, unknown>;
    const savedTechnical = savedData.technical as Record<string, unknown>;

    expect(savedDiagnostic.status).toBe("COMPLETED");
    expect(savedTechnical.opticalPowerDbm).toBe(-19.45);
    expect(caseRepo.events.some((e) => e.type === "DIAGNOSTIC_COMPLETED")).toBe(true);
  });

  it("lanza error si faltan datos de red en el contrato", async () => {
    const caseRepo = new CaseRepositoryFake();
    const created = await caseRepo.create({
      conversationId: "conv-diag-2",
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-1",
      initialState: "START",
      expiresAt: null,
      context: {
        workflowType: "SUPPORT_INTERNET",
        data: {
          contract: {
            id: "1002",
            sector: "pomasqui",
            // faltan oltName, pon, serial
          } as any,
        },
      },
    });

    const actionGateway: N8nGatewayPort = {
      async executeAction() {
        return { success: true, result: {} };
      },
    };

    const useCase = new TriggerCaseDiagnosticUseCase({
      caseRepo,
      actionGateway,
      logger: silentLogger,
    });

    await expect(
      useCase.execute({
        caseId: created.case.id,
        agentUserId: "00000000-0000-0000-0000-000000000001",
      }),
    ).rejects.toThrow(/faltan datos técnicos de red/i);
  });
});
