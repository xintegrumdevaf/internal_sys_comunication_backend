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

  private async loadCasesMap(conversationIds: string[]): Promise<Map<string, Case[]>> {
    if (!this.caseRepo || conversationIds.length === 0) {
      return new Map();
    }
    if (this.caseRepo.listByConversationIds) {
      return this.caseRepo.listByConversationIds(conversationIds);
    }
    const entries = await Promise.all(
      conversationIds.map(async (id) => [id, await this.caseRepo!.listByConversation(id)] as const),
    );
    return new Map(entries);
  }

  private async loadAutomationMap(caseIds: string[]) {
    if (!this.caseRepo || caseIds.length === 0) {
      return new Map();
    }
    if (this.caseRepo.getAutomationStatesByCaseIds) {
      return this.caseRepo.getAutomationStatesByCaseIds(caseIds);
    }
    const entries = await Promise.all(
      caseIds.map(async (id) => [id, await this.caseRepo!.getAutomationState(id)] as const),
    );
    return new Map(entries.flatMap(([id, state]) => (state ? [[id, state] as const] : [])));
  }

  async execute(filter: ListConversationsQuery): Promise<ConversationDto[]> {
    const rawConversations = await this.conversationRepo.list({ status: filter.status });
    if (rawConversations.length === 0) return [];

    // Cargar casos por conversación en lote (evita N+1 por cada chat)
    const casesByConversation = await this.loadCasesMap(rawConversations.map((c) => c.id));

    type ResolvedItem = {
      conv: Conversation;
      activeAggregate: Case | null;
      recordCase: Case | null;
    };

    const resolvedItems: ResolvedItem[] = [];

    for (const conv of rawConversations) {
      const cases = casesByConversation.get(conv.id) ?? [];
      const activeAggregate =
        (conv.activeCaseId ? cases.find((item) => item.id === conv.activeCaseId) : null) ??
        cases.find((item) => item.status === "HUMAN_ACTIVE" || item.status === "ESCALATED") ??
        cases.find((item) => item.status === "ACTIVE" || item.status === "WAITING_USER") ??
        null;

      const isClosedRecord = conv.status === "resolved" || conv.status === "closed";
      const recordCase =
        !activeAggregate && isClosedRecord
          ? ([...cases].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null)
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

    if (resolvedItems.length === 0) return [];

    const activeCaseIds = resolvedItems
      .map((item) => item.activeAggregate?.id)
      .filter((id): id is string => Boolean(id));

    const [lastMap, automationMap, agentsList, departmentsList] = await Promise.all([
      this.messageRepo.findLastByConversationIds(resolvedItems.map((item) => item.conv.id)),
      this.loadAutomationMap(activeCaseIds),
      this.agentRepo ? this.agentRepo.list() : Promise.resolve([]),
      this.departmentRepo ? this.departmentRepo.list() : Promise.resolve([]),
    ]);

    const agentById = new Map(agentsList.map((a) => [a.id, a]));
    const deptById = new Map(departmentsList.map((d) => [d.id, d]));
    const dtos: ConversationDto[] = [];

    for (const { conv, activeAggregate, recordCase } of resolvedItems) {
      const last = lastMap.get(conv.id) ?? null;
      let activeCaseDto: ConversationDto["activeCase"] = null;
      let lastAttendedBy: ConversationDto["lastAttendedBy"] = null;

      if (recordCase) {
        const caseCtx = recordCase.context as Record<string, unknown> | undefined;
        const effectiveAgentId = (caseCtx?.closedByAgentId as string | undefined) || recordCase.assignedAgentId;
        let agentName: string | null = effectiveAgentId ? (agentById.get(effectiveAgentId)?.name ?? null) : null;
        if (!agentName && caseCtx?.closedByAgentName) {
          agentName = String(caseCtx.closedByAgentName);
        }
        lastAttendedBy = {
          agentId: effectiveAgentId,
          agentName,
        };
      }

      if (activeAggregate) {
        const autoState = automationMap.get(activeAggregate.id) ?? null;
        const assignedAgentName = activeAggregate.assignedAgentId
          ? (agentById.get(activeAggregate.assignedAgentId)?.name ?? null)
          : null;
        const dept = activeAggregate.departmentId
          ? deptById.get(activeAggregate.departmentId)
          : undefined;

        activeCaseDto = {
          id: activeAggregate.id,
          status: activeAggregate.status,
          workflowType: activeAggregate.workflowType,
          departmentId: activeAggregate.departmentId,
          departmentName: dept?.name ?? null,
          departmentSlug: dept?.slug ?? null,
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
