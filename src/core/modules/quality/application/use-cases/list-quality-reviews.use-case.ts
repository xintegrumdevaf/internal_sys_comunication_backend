import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { QualityReviewListItem } from "../../domain/quality-review.entity";
import type { QualityReviewStatus } from "../../domain/quality-review.entity";
import type { QualityReviewRepositoryPort } from "../ports/quality-review.repository.port";
import { resolveQualityDepartmentScope } from "../quality-auth";

export class ListQualityReviewsUseCase {
  constructor(
    private readonly deps: {
      qualityRepo: QualityReviewRepositoryPort;
      agentRepo: AgentRepositoryPort;
    },
  ) {}

  async execute(input: {
    actor: Agent;
    agentId?: string;
    from?: Date;
    to?: Date;
    minScore?: number;
    maxScore?: number;
    status?: QualityReviewStatus;
    departmentId?: string;
  }): Promise<QualityReviewListItem[]> {
    const departmentIds = await resolveQualityDepartmentScope(
      input.actor,
      this.deps.agentRepo,
      input.departmentId,
    );

    return this.deps.qualityRepo.listReviews({
      agentId: input.agentId,
      from: input.from,
      to: input.to,
      minScore: input.minScore,
      maxScore: input.maxScore,
      status: input.status,
      departmentIds,
    });
  }
}
