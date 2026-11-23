import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { PaginatedAnalyticsCustomersDto } from "../../domain/analytics.types";
import type { AnalyticsRepositoryPort } from "../ports/analytics.repository.port";
import { resolveAnalyticsDepartmentScope } from "../analytics-auth";

export class ListAnalyticsCustomersUseCase {
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
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PaginatedAnalyticsCustomersDto> {
    const departmentIds = await resolveAnalyticsDepartmentScope(
      input.actor,
      this.deps.agentRepo,
      input.departmentId,
    );

    return this.deps.analyticsRepo.listAttendedCustomers({
      from: input.from,
      to: input.to,
      departmentIds,
      agentId: input.agentId,
      search: input.search,
      page: input.page ?? 1,
      pageSize: Math.min(input.pageSize ?? 25, 100),
    });
  }
}
