import type { Agent } from "../../../departments/domain/agent.entity";
import type { InternalThreadRepositoryPort } from "../../domain/ports/internal-thread.repository.port";
import type { InternalThreadDto } from "../dtos/internal-chat.dto";

export class ListThreadsUseCase {
  constructor(private readonly threadRepo: InternalThreadRepositoryPort) {}

  async execute(currentAgent: Agent): Promise<InternalThreadDto[]> {
    const threads = await this.threadRepo.listThreadsForAgent(currentAgent.id);

    return threads.map((t) => ({
      id: t.id,
      type: t.type,
      referenceId: t.referenceId,
      participants: t.participants.map((p) => ({
        agentId: p.agentId,
        agentName: p.agentName ?? "",
        agentEmail: p.agentEmail ?? "",
        agentRole: p.agentRole ?? "agent",
        lastReadAt: p.lastReadAt.toISOString(),
      })),
      unreadCount: t.unreadCount,
      lastMessage: t.lastMessage
        ? {
            id: t.lastMessage.id,
            senderAgentId: t.lastMessage.senderAgentId,
            senderAgentName: t.lastMessage.senderAgentName ?? "",
            type: t.lastMessage.type,
            body: t.lastMessage.body,
            createdAt: t.lastMessage.createdAt.toISOString(),
          }
        : null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));
  }
}
