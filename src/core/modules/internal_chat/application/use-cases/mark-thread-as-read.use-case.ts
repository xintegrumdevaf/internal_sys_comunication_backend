import { authorizationError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { InternalThreadRepositoryPort } from "../../domain/ports/internal-thread.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export interface MarkThreadAsReadInput {
  currentAgent: Agent;
  threadId: string;
}

export class MarkThreadAsReadUseCase {
  constructor(
    private readonly threadRepo: InternalThreadRepositoryPort,
    private readonly broadcaster?: RealtimeBroadcaster
  ) {}

  async execute(input: MarkThreadAsReadInput): Promise<void> {
    const { currentAgent, threadId } = input;

    const thread = await this.threadRepo.findById(threadId);
    if (!thread) {
      throw notFound("El hilo de chat no existe");
    }

    const isParticipant = await this.threadRepo.isParticipant(threadId, currentAgent.id);
    if (!isParticipant) {
      throw authorizationError("No eres participante de este hilo de chat");
    }

    const now = new Date();
    await this.threadRepo.markThreadRead(threadId, currentAgent.id, now);

    if (this.broadcaster) {
      const participantIds = await this.threadRepo.getParticipantAgentIds(threadId);
      this.broadcaster.publish({
        type: "INTERNAL_THREAD_READ",
        threadId,
        agentId: currentAgent.id,
        readAt: now.toISOString(),
        participantAgentIds: participantIds,
      });
    }
  }
}
