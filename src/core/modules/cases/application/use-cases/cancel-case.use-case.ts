import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case, CaseStatus } from "../../domain/case.entity";
import { ACTIVATABLE_CASE_STATUSES } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";

const CANCELLABLE_STATUSES: CaseStatus[] = ["ACTIVE", "PAUSED", "WAITING_USER"];

export type CancelCaseDeps = {
  caseRepo: CaseRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  logger: Logger;
};

/** docs/spec/02_STATE_MACHINE.md §2 — cancelacion explicita, cualquier estado activo -> CANCELLED. */
export class CancelCaseUseCase {
  constructor(private readonly deps: CancelCaseDeps) {}

  async execute(input: { caseId: string; reason: string }): Promise<Case> {
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) {
      throw notFound(`Caso ${input.caseId} no encontrado`);
    }
    if (!CANCELLABLE_STATUSES.includes(aggregate.case.status)) {
      throw businessError(`No se puede cancelar un caso en estado ${aggregate.case.status}`);
    }

    const wasActivatable = ACTIVATABLE_CASE_STATUSES.includes(aggregate.case.status);

    const result = await this.deps.caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: "CANCELLED",
      context: aggregate.case.context,
      currentState: aggregate.workflowInstance.currentState,
      expiresAt: null,
    });
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_CANCELLED", { reason: input.reason });

    if (wasActivatable) {
      await this.deps.conversationRepo.setActiveCaseId(aggregate.case.conversationId, null);
    }

    this.deps.logger.info(
      { caseId: aggregate.case.id, previousStatus: aggregate.case.status, reason: input.reason },
      "caso cancelado explicitamente",
    );

    return result.case;
  }
}
