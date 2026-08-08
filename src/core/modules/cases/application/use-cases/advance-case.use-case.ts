import { notFound } from "../../../../../shared/errors/domain-errors";
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
};

export type AdvanceCaseInput = {
  caseId: string;
  correlationId: string;
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

  async execute(input: AdvanceCaseInput): Promise<Case> {
    const { caseRepo, conversationRepo, engine } = this.deps;
    const aggregate = await caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso ${input.caseId} no encontrado`);
    }

    const instrumentedGateway = new InstrumentedN8nGateway(
      this.deps.gateway,
      this.deps.workflowExecutionRepo,
      aggregate.workflowInstance.id,
    );

    let currentState = aggregate.workflowInstance.currentState;
    let context = aggregate.case.context;
    let outcome: WorkflowStepOutcome | undefined;

    for (let step = 0; step < MAX_STEPS_PER_RUN; step += 1) {
      outcome = await engine.step(aggregate.case.workflowType, {
        caseId: aggregate.case.id,
        conversationId: aggregate.case.conversationId,
        correlationId: input.correlationId,
        currentState,
        context,
        gateway: instrumentedGateway,
      });

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
      return result.case;
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
      return result.case;
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
      return result.case;
    }

    // outcome.type === "CONTINUE": se agoto MAX_STEPS_PER_RUN sin estabilizar.
    // Se persiste el ultimo estado alcanzado como ACTIVE en vez de perder el avance.
    const result = await caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "ACTIVE",
      context: outcome.context,
      currentState: outcome.nextState,
      expiresAt,
    });
    return result.case;
  }
}
