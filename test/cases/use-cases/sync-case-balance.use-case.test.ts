import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import type { Logger } from "../../../src/shared/logging/logger";
import { SyncCaseBalanceUseCase } from "../../../src/core/modules/cases/application/use-cases/sync-case-balance.use-case";
import { CaseRepositoryFake } from "../fakes";
import type { N8nGatewayPort } from "../../../src/core/modules/cases/application/ports/n8n-gateway.port";

const silentLogger = pino({ level: "silent" }) as unknown as Logger;

describe("SyncCaseBalanceUseCase", () => {
  it("consulta n8n CHECK_BALANCE y actualiza el saldo del cliente en el caso", async () => {
    const caseRepo = new CaseRepositoryFake();
    const created = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-1",
      context: {
        workflowType: "SUPPORT_INTERNET",
        data: {
          client: { nationalId: "1728911387", fullName: "DENISSE MICHELLE CAMALLI RODRIGUEZ" },
          balance: { hasDebt: true, amount: 22.58 }, // Saldo desactualizado previo
        },
      },
      initialState: "ESCALATED",
      expiresAt: null,
    });

    const mockGateway: N8nGatewayPort = {
      executeAction: vi.fn().mockResolvedValue({
        success: true,
        result: {
          hasDebt: true,
          debt: 26.69, // Saldo actualizado en el Excel
        },
      }),
    };

    const mockBroadcaster = {
      publish: vi.fn(),
    };

    const useCase = new SyncCaseBalanceUseCase({
      caseRepo,
      actionGateway: mockGateway,
      broadcaster: mockBroadcaster as any,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      caseId: created.case.id,
      agentUserId: "agent-123",
    });

    expect(result.hasDebt).toBe(true);
    expect(result.amount).toBe(26.69);
    expect(result.nationalId).toBe("1728911387");

    // Verificar que el gateway fue invocado con la acción CHECK_BALANCE y la cédula correcta
    expect(mockGateway.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CHECK_BALANCE",
        input: { id: "1728911387" },
      }),
    );

    // Verificar que el caso en el repositorio quedó con el saldo actualizado
    const updated = await caseRepo.findById(created.case.id);
    const balance = (updated?.case.context.data as any)?.balance;
    expect(balance?.amount).toBe(26.69);
    expect(balance?.hasDebt).toBe(true);

    // Verificar que se emitió el evento
    expect(caseRepo.events).toContainEqual(
      expect.objectContaining({
        caseId: created.case.id,
        type: "BALANCE_SYNCED",
      }),
    );
  });

  it("lanza validationError si el caso no tiene cédula", async () => {
    const caseRepo = new CaseRepositoryFake();
    const created = await caseRepo.create({
      conversationId: "conv-2",
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-1",
      context: {
        workflowType: "SUPPORT_INTERNET",
        data: {},
      },
      initialState: "ESCALATED",
      expiresAt: null,
    });

    const mockGateway: N8nGatewayPort = {
      executeAction: vi.fn(),
    };

    const useCase = new SyncCaseBalanceUseCase({
      caseRepo,
      actionGateway: mockGateway,
      logger: silentLogger,
    });

    await expect(
      useCase.execute({
        caseId: created.case.id,
        agentUserId: "agent-123",
      }),
    ).rejects.toThrow("No se encontró una cédula");
  });
});
