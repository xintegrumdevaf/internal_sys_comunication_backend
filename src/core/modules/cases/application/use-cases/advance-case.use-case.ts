import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../domain/case.entity";
import {
  bumpWaitingAttempts,
  clearWaitingMeta,
  getEngineMeta,
} from "../../domain/contexts/engine-meta";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { WorkflowExecutionRepositoryPort } from "../ports/workflow-execution.repository.port";
import type { N8nGatewayPort } from "../ports/n8n-gateway.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { ConversationIdentityPort } from "../../../customers/application/ports/conversation-identity.port";
import type { EscalationService } from "../../../escalation/application/services/escalation.service";
import type { WorkflowStepOutcome } from "../engine/workflow-definition";
import { WorkflowEngine } from "../engine/workflow-engine";
import { InstrumentedN8nGateway } from "../gateway/instrumented-n8n-gateway";
import { maxAttemptsOf, missingRequiredFields } from "../engine/waiting-step";

const MAX_STEPS_PER_RUN = 10;

export type AdvanceCaseDeps = {
  caseRepo: CaseRepositoryPort;
  workflowExecutionRepo: WorkflowExecutionRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  engine: WorkflowEngine;
  gateway: N8nGatewayPort;
  logger: Logger;
  /** docs/spec/02_STATE_MACHINE.md §14 — reutilización de identidad por conversación. */
  identity?: ConversationIdentityPort;
  escalationService?: EscalationService;
};

export type AdvanceCaseInput = {
  caseId: string;
  correlationId: string;
  text?: string;
  /** Entities de la interpretacion (02_STATE_MACHINE.md §13). */
  entities?: Record<string, unknown>;
};

export type AdvanceCaseResult = {
  case: Case;
  outcome: WorkflowStepOutcome;
};

/**
 * Motor + politica §13 de WaitingStep (requireAll/Any, waitingAttempts, escalacion).
 */
export class AdvanceCaseUseCase {
  constructor(private readonly deps: AdvanceCaseDeps) {}

  async execute(input: AdvanceCaseInput): Promise<AdvanceCaseResult> {
    const { caseRepo, conversationRepo, engine } = this.deps;
    const log = this.deps.logger.child({
      correlationId: input.correlationId,
      caseId: input.caseId,
    });
    const aggregate = await caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso ${input.caseId} no encontrado`);
    }

    const instrumentedGateway = new InstrumentedN8nGateway(
      this.deps.gateway,
      this.deps.workflowExecutionRepo,
      aggregate.workflowInstance.id,
      this.deps.logger,
    );

    let currentState = aggregate.workflowInstance.currentState;
    let context = aggregate.case.context;
    let entities = { ...(input.entities ?? {}) };
    let outcome: WorkflowStepOutcome | undefined;

    const definition = engine.getDefinition(aggregate.case.workflowType);
    const waitingStep = definition?.waitingSteps?.[currentState];

    // §13: si estamos en un WaitingStep y hay mensaje del usuario, evaluar entities.
    if (waitingStep && input.text !== undefined) {
      // Si el paso pide "answer", el texto del usuario ES la respuesta.
      // Algunos modelos devuelven answer:true/boolean; forzamos el string.
      const needsAnswer =
        waitingStep.requireAll?.includes("answer") ||
        waitingStep.requireAny?.includes("answer");
      if (needsAnswer && input.text.trim()) {
        const current = entities.answer;
        if (typeof current !== "string" || current.trim() === "") {
          entities = { ...entities, answer: input.text.trim() };
        }
      }

      const missing = missingRequiredFields(waitingStep, entities);
      if (missing.length > 0) {
        const nextContext = bumpWaitingAttempts(context, missing);
        const attempts = getEngineMeta(nextContext).waitingAttempts ?? 0;
        const max = maxAttemptsOf(waitingStep);
        log.info(
          { currentState, missing, attempts, max },
          "WaitingStep: datos incompletos",
        );

        if (attempts >= max) {
          outcome = {
            type: "ESCALATED",
            reason: `No fue posible obtener ${missing.join(", ")} tras ${max} intentos`,
            context: nextContext,
          };
        } else {
          outcome = {
            type: "WAITING_USER",
            nextState: currentState,
            context: nextContext,
          };
        }
      } else {
        context = clearWaitingMeta(context);
        log.info({ currentState, entities }, "WaitingStep: datos completos, avanzando");
      }
    }

    if (!outcome) {
      for (let step = 0; step < MAX_STEPS_PER_RUN; step += 1) {
        const stateBefore = currentState;
        outcome = await engine.step(aggregate.case.workflowType, {
          caseId: aggregate.case.id,
          conversationId: aggregate.case.conversationId,
          correlationId: input.correlationId,
          currentState,
          context,
          gateway: instrumentedGateway,
          text: input.text,
          entities,
          identity: this.deps.identity,
        });
        log.info(
          { workflowType: aggregate.case.workflowType, stateBefore, outcome: outcome.type },
          "paso del motor de workflow ejecutado",
        );

        if (outcome.type !== "CONTINUE") {
          break;
        }
        currentState = outcome.nextState;
        context = outcome.context;
        // Tras el primer paso, entities ya se consumieron.
        entities = {};
      }
    }

    if (!outcome) {
      throw new Error(`El motor no produjo ningun resultado para el caso ${input.caseId}`);
    }

    const expiresAt = definition
      ? new Date(Date.now() + definition.expirationHours * 60 * 60 * 1000)
      : aggregate.case.expiresAt;

    if (outcome.type === "WAITING_USER") {
      const result = await caseRepo.applyTransition({
        caseId: aggregate.case.id,
        expectedCaseVersion: aggregate.case.version,
        expectedWorkflowVersion: aggregate.workflowInstance.version,
        status: "WAITING_USER",
        context: outcome.context,
        currentState: outcome.nextState,
        expiresAt,
      });
      await caseRepo.appendEvent(aggregate.case.id, "WAITING_USER", {
        nextState: outcome.nextState,
        missingFields: getEngineMeta(outcome.context).missingFields ?? null,
        waitingAttempts: getEngineMeta(outcome.context).waitingAttempts ?? 0,
      });
      await conversationRepo.setActiveCaseId(aggregate.case.conversationId, aggregate.case.id);
      log.info({ status: "WAITING_USER", currentState: outcome.nextState }, "caso a la espera del usuario");
      return { case: result.case, outcome };
    }

    if (outcome.type === "COMPLETED") {
      const result = await caseRepo.applyTransition({
        caseId: aggregate.case.id,
        expectedCaseVersion: aggregate.case.version,
        expectedWorkflowVersion: aggregate.workflowInstance.version,
        status: "COMPLETED",
        context: outcome.context,
        currentState,
        expiresAt: null,
      });
      await caseRepo.appendEvent(aggregate.case.id, "CASE_COMPLETED", {});
      await conversationRepo.setActiveCaseId(aggregate.case.conversationId, null);
      log.info({ status: "COMPLETED" }, "caso completado");
      return { case: result.case, outcome };
    }

    if (outcome.type === "ESCALATED") {
      const result = await caseRepo.applyTransition({
        caseId: aggregate.case.id,
        expectedCaseVersion: aggregate.case.version,
        expectedWorkflowVersion: aggregate.workflowInstance.version,
        status: "ESCALATED",
        context: outcome.context,
        currentState,
        expiresAt: null,
      });
      await caseRepo.setAutomationEnabled(aggregate.case.id, false, { reason: outcome.reason });
      await caseRepo.appendEvent(aggregate.case.id, "CASE_ESCALATED", { reason: outcome.reason });
      await conversationRepo.setActiveCaseId(aggregate.case.conversationId, null);
      let finalCase = result.case;
      if (this.deps.escalationService) {
        const { caseEntity } = await this.deps.escalationService.ensureEscalationRecord({
          caseId: result.case.id,
          reason: outcome.reason,
          correlationId: input.correlationId,
        });
        finalCase = caseEntity;
      }
      log.warn({ status: "ESCALATED", reason: outcome.reason }, "caso escalado, automatizacion deshabilitada");
      return { case: finalCase, outcome };
    }

    log.warn(
      { workflowType: aggregate.case.workflowType, maxSteps: MAX_STEPS_PER_RUN },
      "se agoto el limite de pasos del motor sin llegar a un estado estable",
    );
    const result = await caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "ACTIVE",
      context: outcome.context,
      currentState: outcome.nextState,
      expiresAt,
    });
    return { case: result.case, outcome };
  }
}
