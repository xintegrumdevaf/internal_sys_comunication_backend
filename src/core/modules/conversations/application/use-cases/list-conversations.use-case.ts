import type { Conversation, ConversationStatus } from "../../domain/conversation.entity";
import type { MessageAuthor } from "../../domain/message.entity";
import type { ConversationRepositoryPort, ListConversationsFilter } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";

import type { Case } from "../../../cases/domain/case.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";

export type LastAttendedByDto = {
  agentId: string | null;
  agentName: string | null;
};

export type ConversationDto = Conversation & {
  lastMessagePreview: {
    id?: string;
    body: string;
    type?: string;
    caption?: string | null;
    filename?: string | null;
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
  /**
   * Solo en conversaciones resueltas o cerradas, cuando ya no hay caso activo.
   * Identifica a la última persona asignada a ese caso. No reabre ni reasigna nada.
   */
  lastAttendedBy?: LastAttendedByDto | null;
};

export type ListConversationsQuery = ListConversationsFilter & {
  departmentId?: string;
  userId?: string;
};

/**
 * Lista conversaciones con `lastMessagePreview` (03_API_CONTRACT.md §C.4)
 * y filtros opcionales departmentId/userId. Con un caso vivo se filtra solo
 * por ese caso. En resueltas y cerradas, sin caso vivo, se usa el último caso
 * para saber quién lo atendió.
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
      recordCase: Case | null;
    };

    const resolvedItems: ResolvedItem[] = [];

    for (const conv of rawConversations) {
      const cases = this.caseRepo ? await this.caseRepo.listByConversation(conv.id) : [];
      const activeAggregate =
        (conv.activeCaseId ? cases.find((item) => item.id === conv.activeCaseId) : null) ??
        cases.find((item) => item.status === "HUMAN_ACTIVE" || item.status === "ESCALATED") ??
        cases.find((item) => item.status === "ACTIVE" || item.status === "WAITING_USER") ??
        null;

      const isClosedRecord = conv.status === "resolved" || conv.status === "closed";
      const recordCase =
        !activeAggregate && isClosedRecord
          ? [...cases].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
          : null;

      // Con caso vivo se filtra por ese caso. En resueltas/cerradas, por quien atendió el último.
      const filterCase = activeAggregate ?? recordCase;

      if (filter.departmentId) {
        if (!filterCase || filterCase.departmentId !== filter.departmentId) {
          continue;
        }
      }

      if (filter.userId) {
        if (!filterCase || filterCase.assignedAgentId !== filter.userId) {
          continue;
        }
      }

      resolvedItems.push({ conv, activeAggregate, recordCase });
    }

    const conversations = resolvedItems.map((item) => item.conv);
    const lastMap = await this.messageRepo.findLastByConversationIds(conversations.map((c) => c.id));
    const dtos: ConversationDto[] = [];

    for (const { conv, activeAggregate, recordCase } of resolvedItems) {
      const last = lastMap.get(conv.id) ?? null;
      let activeCaseDto: ConversationDto["activeCase"] = null;
      let lastAttendedBy: ConversationDto["lastAttendedBy"] = null;

      if (recordCase) {
        let agentName: string | null = null;
        const caseCtx = recordCase.context as Record<string, unknown> | undefined;
        const effectiveAgentId = (caseCtx?.closedByAgentId as string | undefined) || recordCase.assignedAgentId;
        if (effectiveAgentId && this.agentRepo) {
          const ag = await this.agentRepo.findById(effectiveAgentId);
          if (ag) agentName = ag.name;
        }
        if (!agentName && caseCtx?.closedByAgentName) {
          agentName = String(caseCtx.closedByAgentName);
        }
        lastAttendedBy = {
          agentId: effectiveAgentId,
          agentName,
        };
      }

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
              id: last.id,
              body: last.body,
              type: last.type,
              caption: last.caption,
              filename: last.filename,
              author: last.author,
              direction: last.direction,
              createdAt: last.createdAt,
            }
          : null,
        activeCase: activeCaseDto,
        lastAttendedBy,
      });
    }

    return dtos;
  }
}

export type { ConversationStatus };
