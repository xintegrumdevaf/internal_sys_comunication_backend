import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../domain/case.entity";
import {
  bumpWaitingAttempts,
  clearWaitingMeta,
  getEngineMeta,
} from "../../domain/contexts/engine-meta";
import type { CaseContext } from "../../domain/contexts/case-context";
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
import { normalizeNationalId } from "../../../customers/domain/national-id";
import type { DepartmentResolverService } from "../services/department-resolver.service";
import { checkCustomerGuardrails } from "../../domain/guardrails";

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
  departmentResolver?: DepartmentResolverService;
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
    let waitingStep = definition?.waitingSteps?.[currentState];

    // §13: si estamos en un WaitingStep y hay mensaje del usuario, evaluar entities.
    if (waitingStep && input.text !== undefined) {
      // Si estamos en WAITING_USER_DISAMBIGUATE y el usuario envía un número de cédula (9 a 13 dígitos):
      // El cliente intenta corregir o reingresar su cédula, no seleccionar un contrato existente.
      if (currentState === "WAITING_USER_DISAMBIGUATE" && input.text) {
        const cedulaMatch = input.text.match(/\b\d{9,13}\b/);
        if (cedulaMatch) {
          const newCedula = normalizeNationalId(cedulaMatch[0]);
          log.info({ newCedula }, "WaitingStep DISAMBIGUATE: detectada cédula nueva/corregida, regresando a VALIDATE_CLIENT");
          currentState = "VALIDATE_CLIENT";
          const currentData = (context && "data" in context ? context.data : {}) as Record<string, unknown>;
          context = {
            ...context,
            data: {
              ...currentData,
              client: { nationalId: newCedula, fullName: "" },
              pendingContracts: undefined,
              contract: undefined,
              clientNotFound: false,
            },
          } as unknown as CaseContext;
          entities = { nationalId: newCedula };
          waitingStep = undefined;
        }
      }

      if (waitingStep) {
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

      // Si el paso pide "selectedOption" y no vino en entities, extraerlo del texto (ej: 1, 2, "option_1", "primero", etc.)
      const needsOption =
        waitingStep.requireAll?.includes("selectedOption") ||
        waitingStep.requireAny?.includes("selectedOption");
      if (needsOption && input.text && entities.selectedOption === undefined) {
        const trimmed = input.text.trim().toLowerCase();
        const digitMatch =
          trimmed.match(/^(?:option_|opci[oó]n\s*#?|el\s+|la\s+|n[uú]mero\s*#?|contrato\s*#?)?\s*([1-9]\d*)(?:[\.\-\:\s]|$)/i) ||
          trimmed.match(/^([1-9]\d*)\b/);
        if (digitMatch && digitMatch[1]) {
          entities = { ...entities, selectedOption: parseInt(digitMatch[1], 10) };
        } else if (trimmed === "primero" || trimmed === "primera" || trimmed === "el primero" || trimmed === "la primera" || trimmed.includes("opcion 1") || trimmed.includes("opción 1")) {
          entities = { ...entities, selectedOption: 1 };
        } else if (trimmed === "segundo" || trimmed === "segunda" || trimmed === "el segundo" || trimmed === "la segunda" || trimmed.includes("opcion 2") || trimmed.includes("opción 2")) {
          entities = { ...entities, selectedOption: 2 };
        } else if (trimmed === "tercero" || trimmed === "tercera" || trimmed === "el tercero" || trimmed === "la tercera" || trimmed.includes("opcion 3") || trimmed.includes("opción 3")) {
          entities = { ...entities, selectedOption: 3 };
        }
      }

      // Si el paso pide "nationalId" y no vino en entities, extraerlo del texto si contiene formato numérico
      const needsNationalId =
        waitingStep.requireAll?.includes("nationalId") ||
        waitingStep.requireAny?.includes("nationalId");
      if (needsNationalId && input.text && !entities.nationalId) {
        const idMatch = input.text.match(/\b\d{9,13}\b/);
        if (idMatch) {
          entities = { ...entities, nationalId: normalizeNationalId(idMatch[0]) };
        }
      }
      if (entities.nationalId) {
        entities = { ...entities, nationalId: normalizeNationalId(entities.nationalId) };
      }

      const requiredKeys = [
        ...(waitingStep.requireAll ?? []),
        ...(waitingStep.requireAny ?? []),
      ];
      const hasProvidedAnyRequiredEntity = requiredKeys.some(
        (key) => key in entities && entities[key] !== undefined && entities[key] !== null && entities[key] !== "",
      );

      // Guardrail anti-hostilidad o rechazo explícito a colaborar
      const guardrail = checkCustomerGuardrails(input.text);
      if (guardrail.shouldEscalate) {
        log.warn(
          { currentState, reason: guardrail.reason, text: input.text },
          "WaitingStep: guardrail activado por hostilidad o rechazo; escalando a humano",
        );
        const missing = missingRequiredFields(waitingStep, entities);
        const nextContext = bumpWaitingAttempts(context, missing.length > 0 ? missing : ["input"]);
        outcome = {
          type: "ESCALATED",
          reason: guardrail.reason ?? "Cliente expresó malestar o rechazo a proporcionar datos",
          context: nextContext,
        };
      } else {
        const missing = missingRequiredFields(waitingStep, entities);
        if (missing.length > 0) {
          // No quemar intentos si el cliente únicamente envió un saludo o puntuación de espera
          const isPureGreetingOrPunctuation = /^(hola|buenos d[ií]as|buenas tardes|buenas noches|buenas|ok|espera|un momento|dame un momento|\?+|\.+)$/i.test(input.text.trim());
          const shouldBump = hasProvidedAnyRequiredEntity || !isPureGreetingOrPunctuation;
          const nextContext = shouldBump ? bumpWaitingAttempts(context, missing) : context;
          const attempts = getEngineMeta(nextContext).waitingAttempts ?? 0;
          const max = maxAttemptsOf(waitingStep);
          log.info(
            { currentState, missing, attempts, max, hasProvidedAnyRequiredEntity, shouldBump },
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
      let targetDepartmentId = aggregate.case.departmentId;
      if (
        this.deps.departmentResolver &&
        (outcome.reason.toLowerCase().includes("ventas") ||
          (outcome.context.workflowType === "GENERAL_INQUIRY" &&
            (outcome.context.data as Record<string, unknown>)?.escalationReason === "SALES_UNANSWERED"))
      ) {
        const salesDeptId = await this.deps.departmentResolver.resolveDepartmentId("sales");
        if (salesDeptId) {
          targetDepartmentId = salesDeptId;
        }
      }

      const result = await caseRepo.applyTransition({
        caseId: aggregate.case.id,
        expectedCaseVersion: aggregate.case.version,
        expectedWorkflowVersion: aggregate.workflowInstance.version,
        status: "ESCALATED",
        context: outcome.context,
        currentState,
        expiresAt: null,
        departmentId: targetDepartmentId,
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
