import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { AuditRepositoryPort, AuditStatsFilter } from "../ports/audit.repository.port";
import type { AuditStatsDto } from "../dtos/audit.dto";
import { resolveAuditDepartmentScope } from "../audit-auth";

export interface GetAuditStatsInput {
  currentAgent: Agent;
  filter?: {
    from?: Date;
    to?: Date;
    departmentId?: string;
  };
}

export class GetAuditStatsUseCase {
  constructor(
    private readonly auditRepo: AuditRepositoryPort,
    private readonly agentRepo: AgentRepositoryPort
  ) {}

  async execute(input: GetAuditStatsInput): Promise<AuditStatsDto> {
    const { currentAgent, filter = {} } = input;

    const departmentScope = await resolveAuditDepartmentScope(
      currentAgent,
      this.agentRepo,
      filter.departmentId
    );

    const queryFilter: AuditStatsFilter = {
      from: filter.from,
      to: filter.to,
      departmentId:
        departmentScope && departmentScope.length === 1 ? departmentScope[0] : undefined,
      departmentIds:
        departmentScope && departmentScope.length > 1 ? departmentScope : undefined,
    };

    return this.auditRepo.getStats(queryFilter);
  }
}
