import { notFound, validationError } from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { InternalThreadRepositoryPort } from "../../domain/ports/internal-thread.repository.port";
import type { InternalThreadDto } from "../dtos/internal-chat.dto";

export interface GetOrCreateDirectThreadInput {
  currentAgent: Agent;
  peerAgentId: string;
  referenceId?: string | null;
}

export class GetOrCreateDirectThreadUseCase {
  constructor(
    private readonly threadRepo: InternalThreadRepositoryPort,
    private readonly agentRepo: AgentRepositoryPort
  ) {}

  async execute(input: GetOrCreateDirectThreadInput): Promise<InternalThreadDto> {
    const { currentAgent, peerAgentId, referenceId } = input;

    if (peerAgentId === currentAgent.id) {
      throw validationError("No puedes crear un chat interno contigo mismo");
    }

    const peerAgent = await this.agentRepo.findById(peerAgentId);
    if (!peerAgent || !peerAgent.active) {
      throw notFound("El agente destinatario no existe o no esta activo");
    }

    let thread = await this.threadRepo.findDirectThreadBetween(currentAgent.id, peerAgentId);

    if (!thread) {
      thread = await this.threadRepo.createDirectThread(currentAgent.id, peerAgentId, referenceId);
    }

    const participants = thread.participants ?? [
      {
        agentId: currentAgent.id,
        agentName: currentAgent.name,
        agentEmail: currentAgent.email,
        agentRole: currentAgent.role,
        lastReadAt: new Date(),
        threadId: thread.id,
      },
      {
        agentId: peerAgent.id,
        agentName: peerAgent.name,
        agentEmail: peerAgent.email,
        agentRole: peerAgent.role,
        lastReadAt: new Date(0),
        threadId: thread.id,
      },
    ];

    return {
      id: thread.id,
      type: thread.type,
      referenceId: thread.referenceId,
      participants: participants.map((p) => ({
        agentId: p.agentId,
        agentName: p.agentName ?? "",
        agentEmail: p.agentEmail ?? "",
        agentRole: p.agentRole ?? "agent",
        lastReadAt: p.lastReadAt.toISOString(),
      })),
      unreadCount: 0,
      lastMessage: null,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    };
  }
}
