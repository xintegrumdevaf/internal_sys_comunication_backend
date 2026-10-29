import { randomUUID } from "node:crypto";
import { notFound, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { N8nGatewayPort } from "../ports/n8n-gateway.port";
import type { ContractRepositoryPort } from "../../../customers/application/ports/customer.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { CaseContext } from "../../domain/contexts/case-context";
import { normalizeDiagnosticResult } from "../engine/definitions/support-internet.workflow";

export type TriggerCaseDiagnosticInput = {
  caseId: string;
  agentUserId: string;
  contractId?: string;
};

export type TriggerCaseDiagnosticResult = {
  caseId: string;
  status: "WAITING_USER" | "COMPLETED" | "ESCALATED";
  diagnostic?: string;
  technical?: Record<string, unknown>;
  executedAt: string;
};

export class TriggerCaseDiagnosticUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      contractRepo?: ContractRepositoryPort;
      conversationRepo?: ConversationRepositoryPort;
      actionGateway: N8nGatewayPort;
      broadcaster?: RealtimeBroadcaster;
      logger: Logger;
    },
  ) {}

  async execute(input: TriggerCaseDiagnosticInput): Promise<TriggerCaseDiagnosticResult> {
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso con id '${input.caseId}' no encontrado`);
    }

    const { case: caseEntity, workflowInstance } = aggregate;
    const contextData = (caseEntity.context?.data ?? {}) as Record<string, unknown>;

    // 1. Validar que tengamos datos técnicos de red para consultar MikroTik / OLT
    let contract = contextData.contract as
      | {
          id?: string;
          sector?: string;
          oltName?: string;
          pon?: string | number;
          serial?: string;
        }
      | undefined;

    if (this.deps.conversationRepo && this.deps.contractRepo) {
      const conv = await this.deps.conversationRepo.findById(caseEntity.conversationId);
      if (conv?.customerId) {
        const dbContracts = await this.deps.contractRepo.listActiveByCustomerId(conv.customerId);
        if (input.contractId) {
          const selected = dbContracts.find(
            (c) => c.id === input.contractId || c.contractNumber === input.contractId,
          );
          if (selected && selected.sector && selected.serial) {
            contract = {
              id: selected.id,
              sector: selected.sector,
              oltName: selected.oltName || "",
              pon: selected.pon ?? "",
              serial: selected.serial,
            };
            contextData.contract = contract;
          }
        } else if (!contract?.sector || !contract?.serial) {
          const primary =
            dbContracts.find((c) => c.sector && c.oltName && c.pon !== undefined && c.serial) ||
            dbContracts.find((c) => c.sector && c.serial) ||
            dbContracts[0];
          if (primary && primary.sector && primary.serial) {
            contract = {
              id: primary.id,
              sector: primary.sector,
              oltName: primary.oltName || "",
              pon: primary.pon ?? "",
              serial: primary.serial,
            };
            contextData.contract = contract;
          }
        }
      }
    }

    if (!contract?.sector || !contract?.serial) {
      throw validationError(
        "No se puede ejecutar diagnóstico: faltan datos técnicos de red (sector o serial). Actualizá los datos del cliente primero con el botón 'Actualizar datos'.",
      );
    }

    const correlationId = `diagnose-${Date.now()}`;
    const executionId = randomUUID();
    const idempotencyKey = `case-diagnose:${caseEntity.id}:${Date.now()}`;

    this.deps.logger.info(
      { caseId: caseEntity.id, contract, correlationId },
      "Ejecutando diagnóstico técnico en la red (DIAGNOSTIC MikroTik / OLT)",
    );

    // 2. Ejecutar acción DIAGNOSTIC contra n8n / MikroTik
    const actionResult = await this.deps.actionGateway.executeAction({
      action: "DIAGNOSTIC",
      caseId: caseEntity.id,
      conversationId: caseEntity.conversationId,
      correlationId,
      executionId,
      idempotencyKey,
      input: {
        sector: contract.sector,
        oltName: contract.oltName || "",
        pon: String(contract.pon ?? ""),
        serial: contract.serial,
        conversationId: caseEntity.conversationId,
      },
    });

    if (!actionResult.success) {
      this.deps.logger.error(
        { caseId: caseEntity.id, error: actionResult.error },
        "Error en la ejecución del servicio de diagnóstico",
      );

      const errorMsg = actionResult.error.message || "Falla en servicio de diagnóstico";

      const updatedContext = {
        ...caseEntity.context,
        data: {
          ...contextData,
          diagnostic: {
            status: "ESCALATED",
            result: errorMsg,
          },
        },
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

      await this.deps.caseRepo.appendEvent(caseEntity.id, "DIAGNOSTIC_FAILED", {
        reason: errorMsg,
        executedByAgentId: input.agentUserId,
      });

      this.deps.broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: caseEntity.conversationId,
        messageId: `diag-err-${caseEntity.id}`,
        author: "system",
      });

      throw validationError(`Error al ejecutar diagnóstico en la red: ${errorMsg}`);
    }

    // 3. Normalizar telemetría y hallazgos
    const output = normalizeDiagnosticResult(
      (actionResult.result ?? {}) as Record<string, unknown>,
    );

    const rawTechResult = (actionResult.result as { technical?: Record<string, unknown> })?.technical;
    const history = Array.isArray(rawTechResult?._history) ? rawTechResult._history : undefined;
    const failedStep = typeof rawTechResult?.failedStep === "string" ? rawTechResult.failedStep : undefined;
    const oltError = typeof rawTechResult?.error === "string" ? rawTechResult.error : undefined;

    const enrichedTechnical = {
      ...(output.technical ?? {}),
      ...(history ? { _history: history } : {}),
      ...(failedStep ? { failedStep } : {}),
      ...(oltError ? { error: oltError } : {}),
    };

    const updatedDiagnostic = {
      status: output.status,
      result: output.diagnostic || output.question || "Diagnóstico completado",
      ...(output.question ? { instruction: output.question } : {}),
      ...(Object.keys(enrichedTechnical).length > 0 ? { technical: enrichedTechnical } : {}),
    };

    const updatedData = {
      ...contextData,
      diagnostic: updatedDiagnostic,
      ...(Object.keys(enrichedTechnical).length > 0 ? { technical: enrichedTechnical } : {}),
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

    await this.deps.caseRepo.appendEvent(caseEntity.id, "DIAGNOSTIC_COMPLETED", {
      status: output.status,
      diagnostic: output.diagnostic,
      technical: enrichedTechnical,
      executedByAgentId: input.agentUserId,
    });

    // 4. Notificar a la UI en tiempo real
    this.deps.broadcaster?.publish({
      type: "MESSAGE_SENT",
      conversationId: caseEntity.conversationId,
      messageId: `diag-${caseEntity.id}`,
      author: "system",
    });

    return {
      caseId: caseEntity.id,
      status: output.status,
      diagnostic: output.diagnostic,
      technical: enrichedTechnical as Record<string, unknown> | undefined,
      executedAt: new Date().toISOString(),
    };
  }
}
