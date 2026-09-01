import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { AnalyticsOverviewDto } from "../../domain/analytics.types";
import type { AnalyticsRepositoryPort } from "../ports/analytics.repository.port";
import { resolveAnalyticsDepartmentScope } from "../analytics-auth";

export class GetAnalyticsOverviewUseCase {
  constructor(
    private readonly deps: {
      analyticsRepo: AnalyticsRepositoryPort;
      agentRepo: AgentRepositoryPort;
    },
  ) {}

  async execute(input: {
    actor: Agent;
    from: Date;
    to: Date;
    departmentId?: string;
  }): Promise<AnalyticsOverviewDto> {
    const departmentIds = await resolveAnalyticsDepartmentScope(
      input.actor,
      this.deps.agentRepo,
      input.departmentId,
    );

    return this.deps.analyticsRepo.getOverview({
      from: input.from,
      to: input.to,
      departmentIds,
    });
  }
}
