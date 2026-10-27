import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { Agent } from "../../../departments/domain/agent.entity";

export type DashboardDto = {
  userId: string;
  role: "agent" | "manager" | "admin";
  openConversations: number;
  myAssignedCases: number;
  escalatedPending: number;
  waitingUser: number;
  unattendedCases: number;
  departmentCases?: number;
  unassignedQueue?: number;
  teamLoad?: Array<{ agentId: string; agentName: string; activeCases: number }>;
  departmentBreakdown?: Array<{ departmentId: string | null; departmentName: string; activeCases: number }>;
};

export type GetDashboardInput =
  | string
  | {
      actor: Agent;
      targetUserId?: string;
    };

/**
 * Cockpit operativo O(1) para el usuario autenticado (03_API_CONTRACT.md §C.1 dashboard).
 * Ejecuta métricas segmentadas por rol (agent, manager, admin) en una sola pasada de base de datos.
 */
export class GetDashboardUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      agentRepo: AgentRepositoryPort;
    },
  ) {}

  async execute(input: GetDashboardInput): Promise<DashboardDto> {
    let actor: Agent | null = null;
    let targetUserId = "";

    if (typeof input === "string") {
      actor = await this.deps.agentRepo.findById(input);
      targetUserId = input;
    } else {
      actor = input.actor;
      targetUserId = input.targetUserId ?? input.actor.id;
    }

    if (!actor) {
      return {
        userId: targetUserId,
        role: "agent",
        openConversations: 0,
        myAssignedCases: 0,
        escalatedPending: 0,
        waitingUser: 0,
        unattendedCases: 0,
      };
    }

    let departmentIds: string[] = [];
    if (actor.role === "manager") {
      const memberships = await this.deps.agentRepo.listMembershipDepartmentIds(actor.id);
      const scoped = new Set<string>(memberships);
      if (actor.primaryDepartmentId) {
        scoped.add(actor.primaryDepartmentId);
      }
      departmentIds = [...scoped];
    }

    const metrics = await this.deps.caseRepo.getDashboardMetrics({
      actorId: actor.id,
      role: actor.role,
      targetUserId,
      departmentIds,
      primaryDepartmentId: actor.primaryDepartmentId ?? null,
    });

    return {
      userId: targetUserId,
      role: actor.role,
      openConversations: metrics.openConversations,
      myAssignedCases: metrics.myAssignedCases,
      escalatedPending: metrics.escalatedPending,
      waitingUser: metrics.waitingUser,
      unattendedCases: metrics.unattendedCases,
      departmentCases: metrics.departmentCases,
      unassignedQueue: metrics.unassignedQueue,
      teamLoad: metrics.teamLoad,
      departmentBreakdown: metrics.departmentBreakdown,
    };
  }
}
