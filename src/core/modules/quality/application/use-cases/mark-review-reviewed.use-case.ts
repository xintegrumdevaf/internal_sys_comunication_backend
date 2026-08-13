import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { QualityReview } from "../../domain/quality-review.entity";
import type { QualityReviewRepositoryPort } from "../ports/quality-review.repository.port";
import { assertCanAccessQualityDepartment } from "../quality-auth";

export class MarkReviewReviewedUseCase {
  constructor(
    private readonly deps: {
      qualityRepo: QualityReviewRepositoryPort;
      agentRepo: AgentRepositoryPort;
      auditRepo: AuditRepositoryPort;
    },
  ) {}

  async execute(input: { actor: Agent; reviewId: string }): Promise<QualityReview> {
    const detail = await this.deps.qualityRepo.findById(input.reviewId);
    if (!detail) throw notFound(`Review ${input.reviewId} no encontrada`);

    await assertCanAccessQualityDepartment(
      input.actor,
      detail.review.departmentId,
      this.deps.agentRepo,
    );

    if (detail.review.status !== "ready" && detail.review.status !== "reviewed") {
      throw businessError(
        `Solo se pueden marcar como revisadas reviews en estado ready (actual: ${detail.review.status})`,
      );
    }

    if (detail.review.status === "reviewed") return detail.review;

    const updated = await this.deps.qualityRepo.markReviewed(input.reviewId);

    await this.deps.auditRepo.record({
      action: "QUALITY_REVIEW_MARKED_REVIEWED",
      resourceType: "quality_review",
      resourceId: input.reviewId,
      actorId: input.actor.id,
      metadata: {},
    });

    return updated;
  }
}
