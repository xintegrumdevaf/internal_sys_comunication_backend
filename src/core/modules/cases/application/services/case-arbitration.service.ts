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
  | { action: "REQUEST_HUMAN"; caseId: string | null; departmentId?: string | null; reason?: string };

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

    const dynamicRouting = this.routingService
      ? await this.routingService.resolveByIntent(interpretation.intent)
      : null;

    if (interpretation.type === "REQUEST_HUMAN") {
      const active = await this.caseRepo.findActiveByConversation(conversationId);
      return {
        action: "REQUEST_HUMAN",
        caseId: active?.case.id ?? null,
        ...(dynamicRouting?.departmentId ? { departmentId: dynamicRouting.departmentId } : {}),
        ...(dynamicRouting?.label ? { reason: dynamicRouting.label } : {}),
      };
    }

    if (interpretation.type === "UNCLEAR") {
      return { action: "CLARIFY" };
    }

    let targetWorkflowType = mapIntentToWorkflowType(interpretation.intent);
    if (!targetWorkflowType && dynamicRouting) {
      targetWorkflowType = dynamicRouting.workflowType;
    }
    const activeAggregate = await this.caseRepo.findActiveByConversation(conversationId);
    const meetsConfidence = interpretation.confidence >= confidenceThreshold(interpretation.intent);

    // Si el enrutamiento está configurado expresamente como human_direct,
    // o si el intent no tiene workflowType automatizado asignado (ej: support.service_cancellation, general.complaint)
    // pero la intención fue comprendida con suficiente confianza:
    // NO forzar CLARIFY; derivar directamente a atención humana / departamento correspondiente.
    const isHumanDirect = dynamicRouting?.handlingMode === "human_direct";
    const isIntentWithoutWorkflow = !targetWorkflowType && Boolean(interpretation.intent) && interpretation.intent !== "unknown";

    if (meetsConfidence && (isHumanDirect || isIntentWithoutWorkflow)) {
      const reason = dynamicRouting?.label || interpretation.intent;
      return {
        action: "REQUEST_HUMAN",
        caseId: activeAggregate?.case.id ?? null,
        ...(dynamicRouting?.departmentId ? { departmentId: dynamicRouting.departmentId } : {}),
        ...(reason ? { reason } : {}),
      };
    }

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

      if (
        interpretation.type === "DENY" ||
        interpretation.type === "CANCEL"
      ) {
        // Si el cliente niega o cancela mientras hay un caso activo, no insistir ni pedir aclaraciones; transferir a humano.
        return { action: "REQUEST_HUMAN", caseId: activeCase.id };
      }

      return { action: "CLARIFY" };
    }

    if (!targetWorkflowType || !meetsConfidence) {
      return { action: "CLARIFY" };
    }

    // Si la conversación ya tiene un caso escalado o en atención humana no expirado:
    // - Si tiene un agente asignado (assignedAgentId) o esta en HUMAN_ACTIVE, mantener atencion humana.
    // - Si esta en ESCALATED sin agente asignado (pool/triage sin reclamar), y llega un NEW_INTENT valido
    //   con alta confianza, permitir activar el workflow automatizado para recopilar la informacion del cliente.
    const allCases = await this.caseRepo.listByConversation(conversationId);
    const pendingHumanCase = [...allCases].reverse().find(
      (c) => (c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED") && !this.expirationService.isExpired(c),
    );
    if (pendingHumanCase) {
      const isAssignedToAgent = pendingHumanCase.status === "HUMAN_ACTIVE" || Boolean(pendingHumanCase.assignedAgentId);
      if (isAssignedToAgent) {
        return { action: "REQUEST_HUMAN", caseId: pendingHumanCase.id };
      }
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
