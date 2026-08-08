import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../domain/case.entity";
import { emptyContextFor } from "../../domain/contexts/case-context";
import type { CaseContext } from "../../domain/contexts/case-context";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { InterpretationPort } from "../ports/interpretation.port";
import { CaseArbitrationService } from "../services/case-arbitration.service";
import { DepartmentResolverService } from "../services/department-resolver.service";
import { WorkflowEngine } from "../engine/workflow-engine";
import { AdvanceCaseUseCase } from "./advance-case.use-case";

export type ProcessBufferedMessagesDeps = {
  caseRepo: CaseRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  departmentResolver: DepartmentResolverService;
  arbitrationService: CaseArbitrationService;
  interpretationProvider: InterpretationPort;
  engine: WorkflowEngine;
  advanceCase: AdvanceCaseUseCase;
  logger: Logger;
};

export type ProcessBufferedMessagesInput = {
  conversationId: string;
  correlationId: string;
  /** Texto de todos los mensajes acumulados por el buffer, ya concatenados/ordenados (02_STATE_MACHINE §12). */
  text: string;
};

/**
 * Consumidor del flush del buffer/debounce (docs/spec/02_STATE_MACHINE.md §12):
 * interpreta la unidad de trabajo acumulada, arbitra que caso corresponde
 * (§4) y avanza el motor de workflow. `interpretationProvider` es el unico
 * punto de extension hacia la IA real (`AIProviderPort`, Etapa 5) — hasta
 * entonces se inyecta una implementacion sintetica que nunca decide negocio.
 */
export class ProcessBufferedMessagesUseCase {
  constructor(private readonly deps: ProcessBufferedMessagesDeps) {}

  async execute(input: ProcessBufferedMessagesInput): Promise<void> {
    const { conversationId, correlationId, text } = input;
    const log = this.deps.logger.child({ correlationId, conversationId });
    const activeAggregate = await this.deps.caseRepo.findActiveByConversation(conversationId);

    const interpretation = await this.deps.interpretationProvider.interpretMessage({
      correlationId,
      conversationId,
      text,
      activeCase: activeAggregate ? { workflowType: activeAggregate.case.workflowType } : null,
    });
    log.info(
      {
        textLength: text.length,
        interpretationType: interpretation.type,
        intent: interpretation.intent,
        confidence: interpretation.confidence,
        activeWorkflowType: activeAggregate?.case.workflowType ?? null,
      },
      "unidad de trabajo interpretada",
    );

    const decision = await this.deps.arbitrationService.decide({ conversationId, interpretation });
    log.info({ decision: decision.action }, "arbitraje de caso decidido");

    if (decision.action === "CLARIFY") {
      // Etapa 5/6: componer y enviar un mensaje de aclaracion. Por ahora, no-op
      // seguro: no se crea ni se toca ningun caso ante una intencion no clara.
      return;
    }

    if (decision.action === "CONTINUE_ACTIVE") {
      await this.deps.advanceCase.execute({ caseId: decision.caseId, correlationId });
      return;
    }

    if (decision.pauseCaseId) {
      await this.pauseCase(decision.pauseCaseId, log);
    }

    const targetCaseId = decision.resumeCaseId ?? (await this.createCase(conversationId, decision.workflowType, log)).id;
    if (decision.resumeCaseId) {
      log.info({ caseId: targetCaseId }, "caso pausado reanudado sin reiniciar el workflow");
      await this.deps.caseRepo.appendEvent(targetCaseId, "CASE_RESUMED", {});
    }

    await this.deps.conversationRepo.setActiveCaseId(conversationId, targetCaseId);
    await this.deps.advanceCase.execute({ caseId: targetCaseId, correlationId });
  }

  private async pauseCase(caseId: string, log: Logger): Promise<void> {
    const aggregate = await this.deps.caseRepo.findById(caseId);
    if (!aggregate) {
      return;
    }
    await this.deps.caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "PAUSED",
      context: aggregate.case.context,
      currentState: aggregate.workflowInstance.currentState,
      expiresAt: aggregate.case.expiresAt,
    });
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_PAUSED", {});
    log.info({ caseId: aggregate.case.id, workflowType: aggregate.case.workflowType }, "caso pausado por cambio de tema");
  }

  private async createCase(conversationId: string, workflowType: string, log: Logger): Promise<Case> {
    const definition = this.deps.engine.getDefinition(workflowType);
    if (!definition) {
      throw new DomainError("UNSUPPORTED", `No hay WorkflowDefinition registrada para '${workflowType}'`);
    }

    const departmentId = await this.deps.departmentResolver.resolveDepartmentId(workflowType);
    const expiresAt = new Date(Date.now() + definition.expirationHours * 60 * 60 * 1000);

    const aggregate = await this.deps.caseRepo.create({
      conversationId,
      workflowType,
      departmentId,
      context: emptyContextFor(workflowType as CaseContext["workflowType"]),
      initialState: definition.initialState,
      expiresAt,
    });
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_CREATED", { workflowType });
    log.info({ caseId: aggregate.case.id, workflowType, departmentId }, "caso nuevo creado");
    return aggregate.case;
  }
}
