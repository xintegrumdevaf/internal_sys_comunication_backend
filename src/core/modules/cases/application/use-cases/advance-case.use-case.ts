import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { WorkflowExecutionRepositoryPort } from "../ports/workflow-execution.repository.port";
import type { N8nGatewayPort } from "../ports/n8n-gateway.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { WorkflowStepOutcome } from "../engine/workflow-definition";
import { WorkflowEngine } from "../engine/workflow-engine";
import { InstrumentedN8nGateway } from "../gateway/instrumented-n8n-gateway";

/** Guarda contra un `WorkflowDefinition` mal formado que nunca deja de devolver CONTINUE. */
const MAX_STEPS_PER_RUN = 10;

export type AdvanceCaseDeps = {
  caseRepo: CaseRepositoryPort;
  workflowExecutionRepo: WorkflowExecutionRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  engine: WorkflowEngine;
  gateway: N8nGatewayPort;
  logger: Logger;
};

export type AdvanceCaseInput = {
  caseId: string;
  correlationId: string;
  /** Texto crudo de la unidad de trabajo que dispara este avance, ver `WorkflowStepInput.text`. */
  text?: string;
};

export type AdvanceCaseResult = {
  case: Case;
  outcome: WorkflowStepOutcome;
};

/**
 * Ejecuta el motor de workflow (docs/spec/02_STATE_MACHINE.md §1-3) sobre un
 * caso existente hasta que llegue a un estado estable (`WAITING_USER`,
 * `COMPLETED`, `ESCALATED`) o se agote `MAX_STEPS_PER_RUN` — encadena pasos
 * que no requieren al usuario (VALIDATE_CLIENT -> CHECK_BALANCE -> DIAGNOSTIC)
 * en una sola invocacion, persistiendo el resultado final de forma optimista.
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
    let outcome: WorkflowStepOutcome | undefined;

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
    }

    if (!outcome) {
      throw new Error(`El motor no produjo ningun resultado para el caso ${input.caseId}`);
    }

    const definition = engine.getDefinition(aggregate.case.workflowType);
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
      await caseRepo.appendEvent(aggregate.case.id, "WAITING_USER", { nextState: outcome.nextState });
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
      log.warn({ status: "ESCALATED", reason: outcome.reason }, "caso escalado, automatizacion deshabilitada");
      return { case: result.case, outcome };
    }

    // outcome.type === "CONTINUE": se agoto MAX_STEPS_PER_RUN sin estabilizar.
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
