import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { AnalyticsExportEstimateDto } from "../../domain/analytics.types";
import type { AnalyticsRepositoryPort } from "../ports/analytics.repository.port";
import { resolveAnalyticsDepartmentScope } from "../analytics-auth";

export const DEFAULT_MAX_EXPORT_ROWS_PER_SHEET = 25_000;

export class GetAnalyticsExportEstimateUseCase {
  constructor(
    private readonly deps: {
      analyticsRepo: AnalyticsRepositoryPort;
      agentRepo: AgentRepositoryPort;
      maxRowsPerSheet?: number;
    },
  ) {}

  async execute(input: {
    actor: Agent;
    from: Date;
    to: Date;
    departmentId?: string;
    agentId?: string;
  }): Promise<AnalyticsExportEstimateDto> {
    const departmentIds = await resolveAnalyticsDepartmentScope(
      input.actor,
      this.deps.agentRepo,
      input.departmentId,
    );

    return this.deps.analyticsRepo.getExportEstimate(
      {
        from: input.from,
        to: input.to,
        departmentIds,
        agentId: input.agentId,
      },
      this.deps.maxRowsPerSheet ?? DEFAULT_MAX_EXPORT_ROWS_PER_SHEET,
    );
  }
}
