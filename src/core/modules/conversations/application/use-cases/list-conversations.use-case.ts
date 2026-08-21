import type { Conversation, ConversationStatus } from "../../domain/conversation.entity";
import type { MessageAuthor } from "../../domain/message.entity";
import type { ConversationRepositoryPort, ListConversationsFilter } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";

import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";

export type ConversationDto = Conversation & {
  lastMessagePreview: {
    body: string;
    author: MessageAuthor;
    direction: "inbound" | "outbound";
    createdAt: Date;
  } | null;
  activeCase?: {
    id: string;
    status: string;
    workflowType: string;
    departmentId: string | null;
    departmentName?: string | null;
    departmentSlug?: string | null;
    assignedAgentId: string | null;
    assignedAgentName?: string | null;
    automationEnabled: boolean;
  } | null;
};

export type ListConversationsQuery = ListConversationsFilter & {
  departmentId?: string;
  userId?: string;
};

/**
 * Lista conversaciones con `lastMessagePreview` (03_API_CONTRACT.md §C.4)
 * y filtros opcionales departmentId/userId vía casos asociados.
 */
export class ListConversationsUseCase {
  constructor(
    private readonly conversationRepo: ConversationRepositoryPort,
    private readonly messageRepo: MessageRepositoryPort,
    private readonly caseRepo?: CaseRepositoryPort,
    private readonly agentRepo?: AgentRepositoryPort,
    private readonly departmentRepo?: DepartmentRepositoryPort,
  ) {}

  async execute(filter: ListConversationsQuery): Promise<ConversationDto[]> {
    let conversations = await this.conversationRepo.list({ status: filter.status });

    if ((filter.departmentId || filter.userId) && this.caseRepo) {
      const filtered: Conversation[] = [];
      for (const conv of conversations) {
        const cases = await this.caseRepo.listByConversation(conv.id);
        const match = cases.some((c) => {
          if (filter.departmentId && c.departmentId !== filter.departmentId) return false;
          if (filter.userId && c.assignedAgentId !== filter.userId) return false;
          return true;
        });
        if (match) filtered.push(conv);
      }
      conversations = filtered;
    }

    const lastMap = await this.messageRepo.findLastByConversationIds(conversations.map((c) => c.id));
    const dtos: ConversationDto[] = [];
    for (const c of conversations) {
      const last = lastMap.get(c.id) ?? null;
      let activeCaseDto: ConversationDto["activeCase"] = null;

      if (this.caseRepo) {
        const cases = await this.caseRepo.listByConversation(c.id);
        const activeAggregate =
          (c.activeCaseId ? cases.find((item) => item.id === c.activeCaseId) : null) ??
          cases.find((item) => item.status === "HUMAN_ACTIVE" || item.status === "ESCALATED") ??
          cases.find((item) => item.status === "ACTIVE" || item.status === "WAITING_USER");

        if (activeAggregate) {
          const autoState = await this.caseRepo.getAutomationState(activeAggregate.id);
          let assignedAgentName: string | null = null;
          let departmentName: string | null = null;
          let departmentSlug: string | null = null;

          if (activeAggregate.assignedAgentId && this.agentRepo) {
            const ag = await this.agentRepo.findById(activeAggregate.assignedAgentId);
            if (ag) assignedAgentName = ag.name;
          }
          if (activeAggregate.departmentId && this.departmentRepo) {
            const dept = await this.departmentRepo.findById(activeAggregate.departmentId);
            if (dept) {
              departmentName = dept.name;
              departmentSlug = dept.slug;
            }
          }

          activeCaseDto = {
            id: activeAggregate.id,
            status: activeAggregate.status,
            workflowType: activeAggregate.workflowType,
            departmentId: activeAggregate.departmentId,
            departmentName,
            departmentSlug,
            assignedAgentId: activeAggregate.assignedAgentId,
            assignedAgentName,
            automationEnabled: autoState ? autoState.enabled : activeAggregate.status !== "HUMAN_ACTIVE" && activeAggregate.status !== "ESCALATED",
          };
        }
      }

      dtos.push({
        ...c,
        lastMessagePreview: last
          ? {
              body: last.body,
              author: last.author,
              direction: last.direction,
              createdAt: last.createdAt,
            }
          : null,
        activeCase: activeCaseDto,
      });
    }

    return dtos;
  }
}

export type { ConversationStatus };
