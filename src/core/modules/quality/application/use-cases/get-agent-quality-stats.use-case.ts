import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { AgentQualityStats } from "../ports/quality-review.repository.port";
import type { QualityReviewRepositoryPort } from "../ports/quality-review.repository.port";
import { resolveQualityDepartmentScope } from "../quality-auth";

export class GetAgentQualityStatsUseCase {
  constructor(
    private readonly deps: {
      qualityRepo: QualityReviewRepositoryPort;
      agentRepo: AgentRepositoryPort;
    },
  ) {}

  async execute(input: {
    actor: Agent;
    from: Date;
    to: Date;
    departmentId?: string;
  }): Promise<AgentQualityStats[]> {
    const departmentIds = await resolveQualityDepartmentScope(
      input.actor,
      this.deps.agentRepo,
      input.departmentId,
    );

    return this.deps.qualityRepo.getAgentStats(input.from, input.to, departmentIds);
  }
}
