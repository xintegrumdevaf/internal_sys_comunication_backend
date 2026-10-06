import type { Conversation, ConversationStatus } from "../../domain/conversation.entity";
import type { MessageAuthor } from "../../domain/message.entity";
import type { ConversationRepositoryPort, ListConversationsFilter } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";

import type { Case } from "../../../cases/domain/case.entity";
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
 * y filtros opcionales departmentId/userId evaluados estrictamente sobre
 * el caso activo (o más reciente vigente), evitando filtrado erróneo por
 * casos históricos previos.
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
    const rawConversations = await this.conversationRepo.list({ status: filter.status });

    // Resolver el caso activo para cada conversación en una sola pasada
    type ResolvedItem = {
      conv: Conversation;
      activeAggregate: Case | null;
    };

    const resolvedItems: ResolvedItem[] = [];

    for (const conv of rawConversations) {
      let activeAggregate: Case | null = null;
      if (this.caseRepo) {
        const cases = await this.caseRepo.listByConversation(conv.id);
        activeAggregate =
          (conv.activeCaseId ? cases.find((item) => item.id === conv.activeCaseId) : null) ??
          cases.find((item) => item.status === "HUMAN_ACTIVE" || item.status === "ESCALATED") ??
          cases.find((item) => item.status === "ACTIVE" || item.status === "WAITING_USER") ??
          null;
      }

      // El filtrado por departamento y agente se evalúa sobre el CASO ACTIVO de la conversación
      if (filter.departmentId) {
        if (!activeAggregate || activeAggregate.departmentId !== filter.departmentId) {
          continue;
        }
      }

      if (filter.userId) {
        if (!activeAggregate || activeAggregate.assignedAgentId !== filter.userId) {
          continue;
        }
      }

      resolvedItems.push({ conv, activeAggregate });
    }

    const conversations = resolvedItems.map((item) => item.conv);
    const lastMap = await this.messageRepo.findLastByConversationIds(conversations.map((c) => c.id));
    const dtos: ConversationDto[] = [];

    for (const { conv, activeAggregate } of resolvedItems) {
      const last = lastMap.get(conv.id) ?? null;
      let activeCaseDto: ConversationDto["activeCase"] = null;

      if (activeAggregate && this.caseRepo) {
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
          automationEnabled: autoState
            ? autoState.enabled
            : activeAggregate.status !== "HUMAN_ACTIVE" && activeAggregate.status !== "ESCALATED",
        };
      }

      dtos.push({
        ...conv,
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
