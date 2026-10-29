import { createHash, randomUUID } from "node:crypto";
import { notFound, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { N8nGatewayPort } from "../ports/n8n-gateway.port";
import type { ContractRepositoryPort, CustomerRepositoryPort } from "../../../customers/application/ports/customer.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { CaseContext } from "../../domain/contexts/case-context";
import { normalizeMikrotikSector, normalizeMikrotikOlt } from "../../infrastructure/diagnostic/mikrotik-diagnostic.adapter";

export type SyncCaseDataInput = {
  caseId: string;
  agentUserId: string;
};

export type SyncedContractData = {
  id?: string;
  sector?: string;
  sectorNom?: string;
  barrioNom?: string;
  address?: string;
  oltName?: string;
  pon?: string | number;
  serial?: string;
  ip?: string;
};

export type SyncedBalanceData = {
  hasDebt: boolean;
  amount: number;
  status: "DEBT" | "NO_DEBT";
};

export type SyncCaseDataResult = {
  caseId: string;
  nationalId: string;
  contract?: SyncedContractData;
  balance?: SyncedBalanceData;
  syncedAt: string;
};

type ContractFromN8n = {
  id?: string | number;
  name?: string;
  address?: string;
  sectorNom?: string;
  sector_nom?: string;
  barrioNom?: string;
  barrio_nom?: string;
  router?: {
    sector?: string;
    olt_name?: string;
    pon?: string | number;
    serial?: string;
    ip?: string;
  };
  sector?: string;
  oltName?: string;
  pon?: string | number;
  serial?: string;
  ip?: string;
};

export class SyncCaseDataUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      customerRepo?: CustomerRepositoryPort;
      contractRepo?: ContractRepositoryPort;
      conversationRepo?: ConversationRepositoryPort;
      actionGateway: N8nGatewayPort;
      broadcaster?: RealtimeBroadcaster;
      logger: Logger;
    },
  ) {}

  async execute(input: SyncCaseDataInput): Promise<SyncCaseDataResult> {
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso con id '${input.caseId}' no encontrado`);
    }

    const { case: caseEntity, workflowInstance } = aggregate;
    const contextData = (caseEntity.context?.data ?? {}) as Record<string, unknown>;

    // 1. Obtener la cédula del cliente (del contexto o de la entidad Customer)
    let nationalId = (contextData.client as { nationalId?: string } | undefined)?.nationalId?.trim();
    let customerId: string | undefined;

    if (this.deps.conversationRepo) {
      const conv = await this.deps.conversationRepo.findById(caseEntity.conversationId);
      if (conv?.customerId) {
        customerId = conv.customerId;
        if (!nationalId && this.deps.customerRepo) {
          const customer = await this.deps.customerRepo.findById(conv.customerId);
          if (customer?.nationalId) {
            nationalId = customer.nationalId.trim();
          }
        }
      }
    }

    if (!nationalId) {
      throw validationError("No se encontró una cédula asociada a este caso o cliente para sincronizar sus datos");
    }

    const correlationId = `sync-data-${Date.now()}`;
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ id: nationalId }))
      .digest("hex")
      .slice(0, 16);

    this.deps.logger.info(
      { caseId: caseEntity.id, nationalId, correlationId },
      "Iniciando sincronización completa de cliente (n8n VALIDATE_CLIENT + CHECK_BALANCE)",
    );

    // 2. Ejecutar VALIDATE_CLIENT y CHECK_BALANCE en paralelo
    const [validateResult, balanceResult] = await Promise.all([
      this.deps.actionGateway.executeAction({
        action: "VALIDATE_CLIENT",
        caseId: caseEntity.id,
        conversationId: caseEntity.conversationId,
        correlationId,
        executionId: randomUUID(),
        idempotencyKey: `case-client-sync:${caseEntity.id}:${inputHash}:${Date.now()}`,
        input: { id: nationalId },
      }),
      this.deps.actionGateway.executeAction({
        action: "CHECK_BALANCE",
        caseId: caseEntity.id,
        conversationId: caseEntity.conversationId,
        correlationId,
        executionId: randomUUID(),
        idempotencyKey: `case-balance-sync:${caseEntity.id}:${inputHash}:${Date.now()}`,
        input: { id: nationalId },
      }),
    ]);

    // Procesar datos de cliente / contrato
    let updatedContract: SyncedContractData | undefined = contextData.contract as SyncedContractData | undefined;
    let clientFullName = (contextData.client as { fullName?: string } | undefined)?.fullName;

    if (validateResult.success) {
      const output = validateResult.result as {
        found?: boolean;
        contracts?: ContractFromN8n[];
      };

      if (output.found && Array.isArray(output.contracts) && output.contracts.length > 0) {
        const currentContractId = updatedContract?.id ? String(updatedContract.id) : undefined;
        const matching = currentContractId
          ? output.contracts.find((c) => String(c.id) === currentContractId)
          : undefined;
        const selected = matching || output.contracts[0]!;

        const rawSector = selected.router?.sector ?? selected.sector ?? updatedContract?.sector;
        const normalizedSector = normalizeMikrotikSector(rawSector) || rawSector;
        const rawOlt = selected.router?.olt_name ?? selected.oltName ?? updatedContract?.oltName;
        const normalizedOlt = normalizeMikrotikOlt(rawOlt, normalizedSector) || rawOlt;

        updatedContract = {
          id: selected.id !== undefined ? String(selected.id) : updatedContract?.id,
          sector: normalizedSector,
          sectorNom: selected.sectorNom ?? selected.sector_nom ?? updatedContract?.sectorNom,
          barrioNom: selected.barrioNom ?? selected.barrio_nom ?? updatedContract?.barrioNom,
          address: selected.address ?? updatedContract?.address,
          oltName: normalizedOlt,
          pon: selected.router?.pon ?? selected.pon ?? updatedContract?.pon,
          serial: selected.router?.serial ?? selected.serial ?? updatedContract?.serial,
          ip: selected.ip ?? selected.router?.ip ?? updatedContract?.ip,
        };

        if (selected.name) {
          clientFullName = selected.name;
        }
      }
    } else {
      this.deps.logger.warn(
        { caseId: caseEntity.id, error: validateResult.error },
        "VALIDATE_CLIENT no devolvió resultado exitoso durante la sincronización",
      );
    }

    // Fallback: si n8n no devolvió contratos pero el cliente ya tiene contratos registrados en Postgres
    if (!updatedContract && this.deps.contractRepo && customerId) {
      const dbContracts = await this.deps.contractRepo.listActiveByCustomerId(customerId);
      if (dbContracts.length > 0) {
        const primary = dbContracts.find((c) => c.sector && c.serial) || dbContracts[0]!;
        updatedContract = {
          id: primary.id,
          sector: primary.sector || undefined,
          oltName: primary.oltName || undefined,
          pon: primary.pon || undefined,
          serial: primary.serial || undefined,
          ip: (primary as any).ip || undefined,
        };
      }
    }

    // Procesar datos de deuda / balance
    let updatedBalance: SyncedBalanceData | undefined;
    if (balanceResult.success) {
      const balanceOutput = balanceResult.result as {
        hasDebt?: boolean;
        debt?: number;
        amount?: number;
      };

      const amount =
        typeof balanceOutput.debt === "number"
          ? balanceOutput.debt
          : typeof balanceOutput.amount === "number"
            ? balanceOutput.amount
            : 0;
      const hasDebt = Boolean(balanceOutput.hasDebt && amount > 0);

      updatedBalance = {
        hasDebt,
        amount,
        status: hasDebt ? "DEBT" : "NO_DEBT",
      };
    } else {
      this.deps.logger.warn(
        { caseId: caseEntity.id, error: balanceResult.error },
        "CHECK_BALANCE no devolvió resultado exitoso durante la sincronización",
      );
    }

    if (!validateResult.success && !balanceResult.success) {
      throw validationError(
        `Error al sincronizar datos del cliente en el ISP: ${balanceResult.error?.message || validateResult.error?.message || "Falla externa"}`,
      );
    }

    // 3. Fusionar en context.data y persistir
    const updatedData = {
      ...contextData,
      client: {
        ...(contextData.client as Record<string, unknown> | undefined),
        nationalId,
        ...(clientFullName ? { fullName: clientFullName } : {}),
      },
      ...(updatedContract ? { contract: updatedContract } : {}),
      ...(updatedBalance ? { balance: updatedBalance } : {}),
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

    await this.deps.caseRepo.appendEvent(caseEntity.id, "DATA_SYNCED", {
      nationalId,
      contract: updatedContract,
      balance: updatedBalance,
      syncedByAgentId: input.agentUserId,
    });

    // 4. Notificar a la UI en tiempo real
    this.deps.broadcaster?.publish({
      type: "MESSAGE_SENT",
      conversationId: caseEntity.conversationId,
      messageId: `data-${caseEntity.id}`,
      author: "system",
    });

    return {
      caseId: caseEntity.id,
      nationalId,
      contract: updatedContract,
      balance: updatedBalance,
      syncedAt: new Date().toISOString(),
    };
  }
}
