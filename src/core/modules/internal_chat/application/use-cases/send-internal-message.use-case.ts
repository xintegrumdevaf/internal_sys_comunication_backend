import { authorizationError, notFound, validationError } from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { InternalMessageType } from "../../domain/entities/internal-message.entity";
import type { InternalThreadRepositoryPort } from "../../domain/ports/internal-thread.repository.port";
import type { InternalMessageRepositoryPort } from "../../domain/ports/internal-message.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { InternalMessageDto } from "../dtos/internal-chat.dto";

export interface SendInternalMessageInput {
  currentAgent: Agent;
  threadId: string;
  body: string;
  type?: InternalMessageType;
  contextData?: Record<string, unknown>;
}

export class SendInternalMessageUseCase {
  constructor(
    private readonly threadRepo: InternalThreadRepositoryPort,
    private readonly messageRepo: InternalMessageRepositoryPort,
    private readonly broadcaster?: RealtimeBroadcaster
  ) {}

  async execute(input: SendInternalMessageInput): Promise<InternalMessageDto> {
    const { currentAgent, threadId, body, type = "text", contextData = {} } = input;

    if (!body || body.trim().length === 0) {
      throw validationError("El mensaje no puede estar vacio");
    }

    const thread = await this.threadRepo.findById(threadId);
    if (!thread) {
      throw notFound("El hilo de chat no existe");
    }

    const isParticipant = await this.threadRepo.isParticipant(threadId, currentAgent.id);
    if (!isParticipant) {
      throw authorizationError("No eres participante de este hilo de chat");
    }

    const message = await this.messageRepo.create({
      threadId,
      senderAgentId: currentAgent.id,
      type,
      body: body.trim(),
      contextData,
    });

    // Auto mark as read for sender
    await this.threadRepo.markThreadRead(threadId, currentAgent.id, message.createdAt);

    // Notify recipients via SSE
    if (this.broadcaster) {
      const participantIds = await this.threadRepo.getParticipantAgentIds(threadId);
      const recipientAgentIds = participantIds.filter((id) => id !== currentAgent.id);

      this.broadcaster.publish({
        type: "INTERNAL_MESSAGE_SENT",
        threadId,
        messageId: message.id,
        senderAgentId: currentAgent.id,
        recipientAgentIds,
        messageType: message.type,
        preview: message.body.slice(0, 100),
        createdAt: message.createdAt.toISOString(),
      });
    }

    return {
      id: message.id,
      threadId: message.threadId,
      senderAgentId: message.senderAgentId,
      senderAgentName: currentAgent.name,
      type: message.type,
      body: message.body,
      contextData: message.contextData,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
