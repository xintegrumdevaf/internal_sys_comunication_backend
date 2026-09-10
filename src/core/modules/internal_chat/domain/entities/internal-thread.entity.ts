import type { AgentRole } from "../../../departments/domain/agent.entity";

export type InternalThreadType = "direct" | "group" | "quality_coaching";

export interface InternalThreadParticipant {
  threadId: string;
  agentId: string;
  agentName?: string;
  agentEmail?: string;
  agentRole?: AgentRole;
  lastReadAt: Date;
}

export interface InternalThread {
  id: string;
  type: InternalThreadType;
  referenceId: string | null;
  createdAt: Date;
  updatedAt: Date;
  participants?: InternalThreadParticipant[];
}
