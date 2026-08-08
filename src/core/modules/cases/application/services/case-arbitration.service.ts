import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { Interpretation } from "../ports/interpretation.port";
import { mapIntentToWorkflowType } from "./intent-workflow-mapper";
import { confidenceThreshold } from "./confidence-threshold";
import { ExpirationService } from "./expiration.service";

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
  | { action: "CLARIFY" };

/**
 * docs/spec/02_STATE_MACHINE.md §4 — un solo caso automatizado activo por
 * conversacion. Servicio de solo lectura/decision: nunca escribe, quien
 * ejecuta la decision (`ProcessBufferedMessagesUseCase`) es responsable de
 * aplicarla de forma transaccional. Esto mantiene la logica de arbitraje
 * testeable con un `CaseRepositoryFake` en memoria, sin tocar Postgres.
 */
export class CaseArbitrationService {
  private readonly expirationService: ExpirationService;

  constructor(private readonly caseRepo: CaseRepositoryPort) {
    this.expirationService = new ExpirationService(caseRepo);
  }

  async decide(input: { conversationId: string; interpretation: Interpretation }): Promise<ArbitrationDecision> {
    const { conversationId, interpretation } = input;

    if (interpretation.type === "UNCLEAR") {
      return { action: "CLARIFY" };
    }

    const targetWorkflowType = mapIntentToWorkflowType(interpretation.intent);
    const activeAggregate = await this.caseRepo.findActiveByConversation(conversationId);

    if (activeAggregate) {
      const activeCase = activeAggregate.case;

      if (targetWorkflowType && targetWorkflowType === activeCase.workflowType) {
        return { action: "CONTINUE_ACTIVE", caseId: activeCase.id };
      }

      if (
        interpretation.type === "CONTINUE" ||
        interpretation.type === "ANSWER" ||
        interpretation.type === "CONFIRM"
      ) {
        // Regla dura (§4.2): generico sobre el caso activo, nunca crea uno nuevo.
        return { action: "CONTINUE_ACTIVE", caseId: activeCase.id };
      }

      if (
        (interpretation.type === "NEW_INTENT" || interpretation.type === "CHANGE_TOPIC") &&
        targetWorkflowType &&
        interpretation.confidence >= confidenceThreshold(interpretation.intent)
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

    if (!targetWorkflowType || interpretation.confidence < confidenceThreshold(interpretation.intent)) {
      return { action: "CLARIFY" };
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
