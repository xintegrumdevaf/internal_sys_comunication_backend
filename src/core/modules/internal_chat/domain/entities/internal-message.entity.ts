export type InternalMessageType = "text" | "quality_quote" | "conversation_excerpt";

export interface InternalMessage {
  id: string;
  threadId: string;
  senderAgentId: string;
  senderAgentName?: string;
  type: InternalMessageType;
  body: string;
  contextData: Record<string, unknown>;
  createdAt: Date;
}
