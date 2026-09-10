import type { InternalMessageType } from "../../domain/entities/internal-message.entity";
import type { InternalThreadType } from "../../domain/entities/internal-thread.entity";
import type { AgentRole } from "../../../departments/domain/agent.entity";

export interface InternalParticipantDto {
  agentId: string;
  agentName: string;
  agentEmail: string;
  agentRole: AgentRole;
  lastReadAt: string;
}

export interface InternalThreadDto {
  id: string;
  type: InternalThreadType;
  referenceId: string | null;
  participants: InternalParticipantDto[];
  unreadCount: number;
  lastMessage: {
    id: string;
    senderAgentId: string;
    senderAgentName: string;
    type: InternalMessageType;
    body: string;
    createdAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface InternalMessageDto {
  id: string;
  threadId: string;
  senderAgentId: string;
  senderAgentName: string;
  type: InternalMessageType;
  body: string;
  contextData: Record<string, unknown>;
  createdAt: string;
}
