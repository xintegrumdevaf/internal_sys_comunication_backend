import { validationError } from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { QualityCoachingNote } from "../../domain/quality-coaching-note.entity";
import type { QualityReviewRepositoryPort } from "../ports/quality-review.repository.port";
import { assertCanAccessQualityDepartment } from "../quality-auth";
import { notFound } from "../../../../../shared/errors/domain-errors";

export class AddCoachingNoteUseCase {
  constructor(
    private readonly deps: {
      qualityRepo: QualityReviewRepositoryPort;
      agentRepo: AgentRepositoryPort;
      auditRepo: AuditRepositoryPort;
    },
  ) {}

  async execute(input: {
    actor: Agent;
    reviewId: string;
    body: string;
  }): Promise<QualityCoachingNote> {
    const trimmed = input.body.trim();
    if (!trimmed) throw validationError("El cuerpo de la nota no puede estar vacio");

    const detail = await this.deps.qualityRepo.findById(input.reviewId);
    if (!detail) throw notFound(`Review ${input.reviewId} no encontrada`);

    await assertCanAccessQualityDepartment(
      input.actor,
      detail.review.departmentId,
      this.deps.agentRepo,
    );

    const note = await this.deps.qualityRepo.addCoachingNote({
      reviewId: input.reviewId,
      authorAgentId: input.actor.id,
      body: trimmed,
    });

    await this.deps.auditRepo.record({
      action: "QUALITY_COACHING_NOTE_CREATED",
      resourceType: "quality_review",
      resourceId: input.reviewId,
      actorId: input.actor.id,
      metadata: { noteId: note.id },
    });

    return note;
  }
}
