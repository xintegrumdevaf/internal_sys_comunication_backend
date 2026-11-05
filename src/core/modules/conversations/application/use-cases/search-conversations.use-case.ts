import type { Conversation } from "../../domain/conversation.entity";
import type { MessageAuthor } from "../../domain/message.entity";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { Case } from "../../../cases/domain/case.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { ConversationDto } from "./list-conversations.use-case";

export type ConversationSearchResultDto = ConversationDto & {
  matchedMessage?: {
    id: string;
    body: string;
    author: MessageAuthor;
    createdAt: Date;
  } | null;
};

export type SearchConversationsQuery = {
  query: string;
  limit?: number;
  departmentId?: string;
  userId?: string;
};

/**
 * Búsqueda optimizada y profunda de conversaciones y mensajes en PostgreSQL.
 * Busca por:
 * - Teléfono o cédula del cliente
 * - Nombres y apellidos del titular (customer.full_name)
 * - Nombre de perfil de WhatsApp (wa_profile_name)
 * - Contenido de mensajes históricos usando índice trigram GIN (body ILIKE %q%)
 */
export class SearchConversationsUseCase {
  constructor(
    private readonly conversationRepo: ConversationRepositoryPort,
    private readonly messageRepo: MessageRepositoryPort,
    private readonly caseRepo?: CaseRepositoryPort,
    private readonly agentRepo?: AgentRepositoryPort,
    private readonly departmentRepo?: DepartmentRepositoryPort,
  ) {}

  async execute(input: SearchConversationsQuery): Promise<ConversationSearchResultDto[]> {
    const cleanQ = input.query.trim();
    if (!cleanQ) return [];

    const matches = await this.conversationRepo.search(cleanQ, { limit: input.limit ?? 25 });
    if (matches.length === 0) return [];

    const lastMap = await this.messageRepo.findLastByConversationIds(
      matches.map((m) => m.conversation.id),
    );

    const dtos: ConversationSearchResultDto[] = [];

    for (const { conversation: conv, matchedMessage } of matches) {
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

      const filterCase = activeAggregate ?? recordCase;

      if (input.departmentId) {
        if (!filterCase || filterCase.departmentId !== input.departmentId) {
          continue;
        }
      }

      if (input.userId) {
        if (!filterCase || filterCase.assignedAgentId !== input.userId) {
          continue;
        }
      }

      let activeCaseDto: ConversationDto["activeCase"] = null;
      let lastAttendedBy: ConversationDto["lastAttendedBy"] = null;

      if (recordCase) {
        let agentName: string | null = null;
        const caseCtx = recordCase.context as Record<string, unknown> | undefined;
        const effectiveAgentId =
          (caseCtx?.closedByAgentId as string | undefined) || recordCase.assignedAgentId;
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

      const last = lastMap.get(conv.id) ?? null;

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
        lastAttendedBy,
        matchedMessage,
      });
    }

    return dtos;
  }
}

