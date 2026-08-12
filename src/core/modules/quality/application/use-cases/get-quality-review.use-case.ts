import { notFound } from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { QualityReviewDetail } from "../ports/quality-review.repository.port";
import type { QualityReviewRepositoryPort } from "../ports/quality-review.repository.port";
import { assertCanAccessQualityDepartment } from "../quality-auth";

export class GetQualityReviewUseCase {
  constructor(
    private readonly deps: {
      qualityRepo: QualityReviewRepositoryPort;
      agentRepo: AgentRepositoryPort;
    },
  ) {}

  async execute(input: { actor: Agent; reviewId: string }): Promise<QualityReviewDetail> {
    const detail = await this.deps.qualityRepo.findById(input.reviewId);
    if (!detail) throw notFound(`Review ${input.reviewId} no encontrada`);

    await assertCanAccessQualityDepartment(
      input.actor,
      detail.review.departmentId,
      this.deps.agentRepo,
    );

    return detail;
  }
}
