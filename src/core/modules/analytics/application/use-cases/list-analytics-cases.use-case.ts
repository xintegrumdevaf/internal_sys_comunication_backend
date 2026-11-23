import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type {
  AnalyticsCaseAttentionMode,
  PaginatedAnalyticsCasesDto,
} from "../../domain/analytics.types";
import type { AnalyticsRepositoryPort } from "../ports/analytics.repository.port";
import { resolveAnalyticsDepartmentScope } from "../analytics-auth";

export class ListAnalyticsCasesUseCase {
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
    agentId?: string;
    status?: string;
    attentionMode?: AnalyticsCaseAttentionMode;
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PaginatedAnalyticsCasesDto> {
    const departmentIds = await resolveAnalyticsDepartmentScope(
      input.actor,
      this.deps.agentRepo,
      input.departmentId,
    );

    return this.deps.analyticsRepo.listAttendedCases({
      from: input.from,
      to: input.to,
      departmentIds,
      agentId: input.agentId,
      status: input.status,
      attentionMode: input.attentionMode,
      search: input.search,
      page: input.page ?? 1,
      pageSize: Math.min(input.pageSize ?? 25, 100),
    });
  }
}
