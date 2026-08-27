import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { AuditRepositoryPort, ListAuditEventsFilter } from "../ports/audit.repository.port";
import type { AuditEventDto } from "../dtos/audit.dto";
import { resolveAuditDepartmentScope } from "../audit-auth";

export interface ListAuditEventsInput {
  currentAgent: Agent;
  filter: ListAuditEventsFilter;
}

export class ListAuditEventsUseCase {
  constructor(
    private readonly auditRepo: AuditRepositoryPort,
    private readonly agentRepo: AgentRepositoryPort
  ) {}

  async execute(
    input: ListAuditEventsInput
  ): Promise<{ events: AuditEventDto[]; nextCursor: string | null }> {
    const { currentAgent, filter } = input;

    const departmentScope = await resolveAuditDepartmentScope(
      currentAgent,
      this.agentRepo,
      filter.departmentId
    );

    const queryFilter: ListAuditEventsFilter = {
      ...filter,
      departmentId:
        departmentScope && departmentScope.length === 1 ? departmentScope[0] : undefined,
      departmentIds:
        departmentScope && departmentScope.length > 1 ? departmentScope : undefined,
    };

    const { events, nextCursor } = await this.auditRepo.list(queryFilter);

    return {
      events: events.map((e) => ({
        id: e.id,
        action: e.action,
        category: e.category,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        actor: {
          id: e.actorId,
          name: e.actorName ?? (e.actorType === "system" ? "Sistema" : "Desconocido"),
          email: e.actorEmail ?? null,
          role: e.actorRole ?? null,
          type: e.actorType,
        },
        department: e.departmentId
          ? {
              id: e.departmentId,
              name: e.departmentName ?? "Departamento",
            }
          : null,
        metadata: e.metadata,
        beforeState: e.beforeState,
        afterState: e.afterState,
        ipAddress: e.ipAddress,
        userAgent: e.userAgent,
        correlationId: e.correlationId,
        occurredAt: e.occurredAt.toISOString(),
      })),
      nextCursor,
    };
  }
}
