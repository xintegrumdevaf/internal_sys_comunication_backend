import { authorizationError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { InternalThreadRepositoryPort } from "../../domain/ports/internal-thread.repository.port";
import type {
  InternalMessageRepositoryPort,
  ListInternalMessagesOptions,
} from "../../domain/ports/internal-message.repository.port";
import type { InternalMessageDto } from "../dtos/internal-chat.dto";

export interface ListInternalMessagesInput {
  currentAgent: Agent;
  threadId: string;
  options?: ListInternalMessagesOptions;
}

export class ListMessagesUseCase {
  constructor(
    private readonly threadRepo: InternalThreadRepositoryPort,
    private readonly messageRepo: InternalMessageRepositoryPort
  ) {}

  async execute(
    input: ListInternalMessagesInput
  ): Promise<{ messages: InternalMessageDto[]; nextCursor: string | null }> {
    const { currentAgent, threadId, options } = input;

    const thread = await this.threadRepo.findById(threadId);
    if (!thread) {
      throw notFound("El hilo de chat no existe");
    }

    const isParticipant = await this.threadRepo.isParticipant(threadId, currentAgent.id);
    if (!isParticipant && currentAgent.role !== "admin") {
      throw authorizationError("No tienes acceso a este hilo de chat");
    }

    const result = await this.messageRepo.listByThread(threadId, options);

    return {
      messages: result.messages.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        senderAgentId: m.senderAgentId,
        senderAgentName: m.senderAgentName ?? "",
        type: m.type,
        body: m.body,
        contextData: m.contextData ?? {},
        createdAt: m.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }
}
