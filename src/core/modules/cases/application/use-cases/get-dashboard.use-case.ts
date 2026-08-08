import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { EscalationRepositoryPort } from "../../../escalation/application/ports/escalation.repository.port";

export type DashboardDto = {
  userId: string;
  openConversations: number;
  myAssignedCases: number;
  escalatedPending: number;
  waitingUser: number;
};

/**
 * KPIs mínimos para el agente autenticado (03_API_CONTRACT.md §C.1 dashboard).
 */
export class GetDashboardUseCase {
  constructor(
    private readonly deps: {
      conversationRepo: ConversationRepositoryPort;
      caseRepo: CaseRepositoryPort;
      agentRepo: AgentRepositoryPort;
      escalationRepo: EscalationRepositoryPort;
    },
  ) {}

  async execute(userId: string): Promise<DashboardDto> {
    const agent = await this.deps.agentRepo.findById(userId);
    if (!agent) {
      return {
        userId,
        openConversations: 0,
        myAssignedCases: 0,
        escalatedPending: 0,
        waitingUser: 0,
      };
    }

    const conversations = await this.deps.conversationRepo.list({ status: "open" });
    let myAssignedCases = 0;
    let waitingUser = 0;

    for (const conv of conversations) {
      if (!conv.activeCaseId) continue;
      const aggregate = await this.deps.caseRepo.findById(conv.activeCaseId);
      if (!aggregate) continue;
      if (aggregate.case.assignedAgentId === userId) myAssignedCases += 1;
      if (aggregate.case.status === "WAITING_USER") waitingUser += 1;
    }

    const pending = await this.deps.escalationRepo.list({ status: "PENDING" });

    return {
      userId,
      openConversations: conversations.length,
      myAssignedCases,
      escalatedPending: pending.length,
      waitingUser,
    };
  }
}
