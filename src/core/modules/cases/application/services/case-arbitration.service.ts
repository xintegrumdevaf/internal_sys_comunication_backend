import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { Interpretation } from "../ports/interpretation.port";
import type { Logger } from "../../../../../shared/logging/logger";
import { mapIntentToWorkflowType } from "./intent-workflow-mapper";
import { confidenceThreshold } from "./confidence-threshold";
import { ExpirationService } from "./expiration.service";
import type { DepartmentRoutingService } from "../../../departments/application/services/department-routing.service";

export type ArbitrationDecision =
  | { action: "CONTINUE_ACTIVE"; caseId: string }
  | {
    action: "ACTIVATE";
    workflowType: string;
    /** Caso `PAUSED` no expirado del `workflowType` destino a reanudar, o null para crear uno nuevo. */
    resumeCaseId: string | null;
    /** Caso activo actual que hay que pausar antes de activar el destino, o null si no habia ninguno. */
    pauseCaseId: string | null;
  }
  | { action: "CLARIFY" }
  | { action: "REQUEST_HUMAN"; caseId: string | null };

/**
 * docs/spec/02_STATE_MACHINE.md §4 + §7 — un solo caso automatizado activo
 * por conversacion. Servicio de solo lectura/decision: nunca escribe.
 */
export class CaseArbitrationService {
  private readonly expirationService: ExpirationService;

  constructor(
    private readonly caseRepo: CaseRepositoryPort,
    logger: Logger,
    private readonly routingService?: DepartmentRoutingService,
  ) {
    this.expirationService = new ExpirationService(caseRepo, logger);
  }

  async decide(input: { conversationId: string; interpretation: Interpretation }): Promise<ArbitrationDecision> {
    const { conversationId, interpretation } = input;

    if (interpretation.type === "REQUEST_HUMAN") {
      const active = await this.caseRepo.findActiveByConversation(conversationId);
      return { action: "REQUEST_HUMAN", caseId: active?.case.id ?? null };
    }

    if (interpretation.type === "UNCLEAR") {
      return { action: "CLARIFY" };
    }

    let targetWorkflowType = mapIntentToWorkflowType(interpretation.intent);
    if (!targetWorkflowType && this.routingService) {
      const dynamicRouting = await this.routingService.resolveByIntent(interpretation.intent);
      if (dynamicRouting) {
        targetWorkflowType = dynamicRouting.workflowType;
      }
    }
    const activeAggregate = await this.caseRepo.findActiveByConversation(conversationId);
    const meetsConfidence = interpretation.confidence >= confidenceThreshold(interpretation.intent);

    if (activeAggregate) {
      const activeCase = activeAggregate.case;

      if (targetWorkflowType && targetWorkflowType === activeCase.workflowType) {
        return { action: "CONTINUE_ACTIVE", caseId: activeCase.id };
      }

      // Si el intent detectado mapea a un workflowType DISTINTO al activo y la confianza es suficiente,
      // la intención del cliente cambió: pausar el caso activo y activar el nuevo flujo (ej. pasar de Soporte a Planes/RAG).
      if (targetWorkflowType && targetWorkflowType !== activeCase.workflowType && meetsConfidence) {
        const resumeCaseId = await this.findResumableCaseId(conversationId, targetWorkflowType);
        return {
          action: "ACTIVATE",
          workflowType: targetWorkflowType,
          resumeCaseId,
          pauseCaseId: activeCase.id,
        };
      }

      if (
        interpretation.type === "CONTINUE" ||
        interpretation.type === "ANSWER" ||
        interpretation.type === "CONFIRM"
      ) {
        return { action: "CONTINUE_ACTIVE", caseId: activeCase.id };
      }

      // §7: baja confianza con caso activo → continuar ese caso (no pausar/crear).
      if (!meetsConfidence) {
        return { action: "CONTINUE_ACTIVE", caseId: activeCase.id };
      }

      if (
        (interpretation.type === "NEW_INTENT" || interpretation.type === "CHANGE_TOPIC") &&
        targetWorkflowType
      ) {
        const resumeCaseId = await this.findResumableCaseId(conversationId, targetWorkflowType);
        return {
          action: "ACTIVATE",
          workflowType: targetWorkflowType,
          resumeCaseId,
          pauseCaseId: activeCase.id,
        };
      }

      return { action: "CLARIFY" };
    }

    if (!targetWorkflowType || !meetsConfidence) {
      return { action: "CLARIFY" };
    }

    // Si la conversación ya tiene un caso escalado o atendido por humanos no expirado,
    // no abrir un nuevo caso automatizado; mantener la atención con el asesor humano.
    const allCases = await this.caseRepo.listByConversation(conversationId);
    const pendingHumanCase = [...allCases].reverse().find(
      (c) => (c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED") && !this.expirationService.isExpired(c),
    );
    if (pendingHumanCase) {
      return { action: "REQUEST_HUMAN", caseId: pendingHumanCase.id };
    }

    const resumeCaseId = await this.findResumableCaseId(conversationId, targetWorkflowType);
    return { action: "ACTIVATE", workflowType: targetWorkflowType, resumeCaseId, pauseCaseId: null };
  }

  private async findResumableCaseId(conversationId: string, workflowType: string): Promise<string | null> {
    const paused = await this.caseRepo.findPausedByConversationAndType(conversationId, workflowType);
    if (!paused || this.expirationService.isExpired(paused.case)) {
      return null;
    }
    return paused.case.id;
  }
}
