import type { InternalThread, InternalThreadParticipant } from "../entities/internal-thread.entity";
import type { InternalMessage } from "../entities/internal-message.entity";

export interface ThreadWithMetadata extends InternalThread {
  participants: InternalThreadParticipant[];
  unreadCount: number;
  lastMessage: InternalMessage | null;
}

export interface InternalThreadRepositoryPort {
  findById(id: string): Promise<InternalThread | null>;
  findDirectThreadBetween(agentAId: string, agentBId: string): Promise<InternalThread | null>;
  createDirectThread(agentAId: string, agentBId: string, referenceId?: string | null): Promise<InternalThread>;
  listThreadsForAgent(agentId: string): Promise<ThreadWithMetadata[]>;
  isParticipant(threadId: string, agentId: string): Promise<boolean>;
  getParticipantAgentIds(threadId: string): Promise<string[]>;
  markThreadRead(threadId: string, agentId: string, readAt?: Date): Promise<void>;
}
