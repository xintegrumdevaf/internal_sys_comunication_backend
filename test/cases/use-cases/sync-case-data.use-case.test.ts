import { describe, it, expect } from "vitest";
import pino from "pino";
import type { Logger } from "../../../src/shared/logging/logger";
import { SyncCaseDataUseCase } from "../../../src/core/modules/cases/application/use-cases/sync-case-data.use-case";
import { CaseRepositoryFake } from "../fakes";
import type { N8nGatewayPort } from "../../../src/core/modules/cases/application/ports/n8n-gateway.port";

const silentLogger = pino({ level: "silent" }) as unknown as Logger;

describe("SyncCaseDataUseCase", () => {
  it("sincroniza ficha de cliente (contrato, sector, OLT, PON, serial) y saldo simultáneamente", async () => {
    const caseRepo = new CaseRepositoryFake();
    const created = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-1",
      initialState: "DIAGNOSTIC",
      expiresAt: null,
      context: {
        workflowType: "SUPPORT_INTERNET",
        data: {
          client: { nationalId: "1720001112", fullName: "Carlos Gomez" },
          contract: {
            id: "1001",
            sector: "antiguo_sector",
            oltName: "antigua_olt",
            pon: "1",
            serial: "OLDSERIAL1234",
          },
          balance: { hasDebt: false, amount: 0 },
        },
      },
    });

    const actionGateway: N8nGatewayPort = {
      async executeAction(req) {
        if (req.action === "VALIDATE_CLIENT") {
          return {
            success: true,
            result: {
              found: true,
              contracts: [
                {
                  id: "1001",
                  name: "Carlos Gomez Actualizado",
                  router: {
                    sector: "pomasqui",
                    olt_name: "bicentenario",
                    pon: "3",
                    serial: "D011A66CB67C",
                    ip: "10.0.1.55",
                  },
                },
              ],
            },
          };
        }
        if (req.action === "CHECK_BALANCE") {
          return {
            success: true,
            result: {
              hasDebt: true,
              amount: 26.69,
            },
          };
        }
        return {
          success: false,
          error: { type: "NOT_FOUND", message: "Acción no soportada", retryable: false },
        };
      },
    };

    const useCase = new SyncCaseDataUseCase({
      caseRepo,
      actionGateway,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      caseId: created.case.id,
      agentUserId: "00000000-0000-0000-0000-000000000001",
    });

    expect(result.contract?.sector).toBe("pomasqui");
    expect(result.contract?.oltName).toBe("bicentenario");
    expect(result.contract?.pon).toBe("3");
    expect(result.contract?.serial).toBe("D011A66CB67C");
    expect(result.contract?.ip).toBe("10.0.1.55");
    expect(result.balance?.hasDebt).toBe(true);
    expect(result.balance?.amount).toBe(26.69);

    const saved = await caseRepo.findById(created.case.id);
    const savedData = (saved?.case.context?.data ?? {}) as Record<string, unknown>;
    const savedContract = savedData.contract as Record<string, unknown>;
    const savedBalance = savedData.balance as Record<string, unknown>;

    expect(savedContract.sector).toBe("pomasqui");
    expect(savedContract.serial).toBe("D011A66CB67C");
    expect(savedBalance.amount).toBe(26.69);
    expect(caseRepo.events.some((e) => e.type === "DATA_SYNCED")).toBe(true);
  });

  it("lanza error si no existe cédula asociada en el caso", async () => {
    const caseRepo = new CaseRepositoryFake();
    const created = await caseRepo.create({
      conversationId: "conv-2",
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-1",
      initialState: "START",
      expiresAt: null,
      context: {
        workflowType: "SUPPORT_INTERNET",
        data: {},
      },
    });

    const actionGateway: N8nGatewayPort = {
      async executeAction() {
        return { success: true, result: {} };
      },
    };

    const useCase = new SyncCaseDataUseCase({
      caseRepo,
      actionGateway,
      logger: silentLogger,
    });

    await expect(
      useCase.execute({
        caseId: created.case.id,
        agentUserId: "00000000-0000-0000-0000-000000000001",
      }),
    ).rejects.toThrow(/cédula/i);
  });
});
