import { createHash, randomUUID } from "node:crypto";
import { notFound, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { N8nGatewayPort } from "../ports/n8n-gateway.port";
import type { CustomerRepositoryPort } from "../../../customers/application/ports/customer.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { CaseContext } from "../../domain/contexts/case-context";

export type SyncCaseBalanceInput = {
  caseId: string;
  agentUserId: string;
};

export type SyncCaseBalanceResult = {
  caseId: string;
  hasDebt: boolean;
  amount: number;
  nationalId: string;
  syncedAt: string;
};

export class SyncCaseBalanceUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      customerRepo?: CustomerRepositoryPort;
      conversationRepo?: ConversationRepositoryPort;
      actionGateway: N8nGatewayPort;
      broadcaster?: RealtimeBroadcaster;
      logger: Logger;
    },
  ) {}

  async execute(input: SyncCaseBalanceInput): Promise<SyncCaseBalanceResult> {
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso con id '${input.caseId}' no encontrado`);
    }

    const { case: caseEntity, workflowInstance } = aggregate;
    const contextData = (caseEntity.context?.data ?? {}) as Record<string, unknown>;

    // 1. Obtener la cédula del cliente
    let nationalId = (contextData.client as { nationalId?: string } | undefined)?.nationalId?.trim();

    if (!nationalId && this.deps.conversationRepo && this.deps.customerRepo) {
      const conv = await this.deps.conversationRepo.findById(caseEntity.conversationId);
      if (conv?.customerId) {
        const customer = await this.deps.customerRepo.findById(conv.customerId);
        if (customer?.nationalId) {
          nationalId = customer.nationalId.trim();
        }
      }
    }

    if (!nationalId) {
      throw validationError("No se encontró una cédula asociada a este caso o cliente para consultar el saldo");
    }

    const correlationId = `sync-balance-${Date.now()}`;
    const executionId = randomUUID();
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ id: nationalId }))
      .digest("hex")
      .slice(0, 16);
    const idempotencyKey = `case-balance-sync:${caseEntity.id}:${inputHash}:${Date.now()}`;

    this.deps.logger.info(
      { caseId: caseEntity.id, nationalId, correlationId },
      "Consultando saldo actualizado en el ISP (n8n CHECK_BALANCE)",
    );

    const actionResult = await this.deps.actionGateway.executeAction({
      action: "CHECK_BALANCE",
      caseId: caseEntity.id,
      conversationId: caseEntity.conversationId,
      correlationId,
      executionId,
      idempotencyKey,
      input: { id: nationalId },
    });

    if (!actionResult.success) {
      throw validationError(`Error al consultar saldo en el ISP: ${actionResult.error.message}`);
    }

    const output = actionResult.result as {
      hasDebt?: boolean;
      debt?: number;
      amount?: number;
    };

    const amount =
      typeof output.debt === "number"
        ? output.debt
        : typeof output.amount === "number"
          ? output.amount
          : 0;
    const hasDebt = Boolean(output.hasDebt && amount > 0);

    // 2. Actualizar el contexto del caso
    const updatedData = {
      ...contextData,
      balance: {
        hasDebt,
        amount,
        status: hasDebt ? "DEBT" : "NO_DEBT",
      },
    };

    const updatedContext = {
      ...caseEntity.context,
      data: updatedData,
    } as unknown as CaseContext;

    await this.deps.caseRepo.applyTransition({
      caseId: caseEntity.id,
      expectedCaseVersion: caseEntity.version,
      expectedWorkflowVersion: workflowInstance.version,
      status: caseEntity.status,
      context: updatedContext,
      currentState: workflowInstance.currentState,
      expiresAt: caseEntity.expiresAt,
      departmentId: caseEntity.departmentId,
    });

    await this.deps.caseRepo.appendEvent(caseEntity.id, "BALANCE_SYNCED", {
      hasDebt,
      amount,
      syncedByAgentId: input.agentUserId,
      nationalId,
    });

    // 3. Notificar en tiempo real al frontend
    this.deps.broadcaster?.publish({
      type: "MESSAGE_SENT",
      conversationId: caseEntity.conversationId,
      messageId: `bal-${caseEntity.id}`,
      author: "system",
    });

    return {
      caseId: caseEntity.id,
      hasDebt,
      amount,
      nationalId,
      syncedAt: new Date().toISOString(),
    };
  }
}
