export type MessageDirection = "inbound" | "outbound";
export type MessageAuthor = "customer" | "ai" | "agent" | "system";

export interface Message {
  id: string;
  conversationId: string;
  caseId: string | null;
  direction: MessageDirection;
  author: MessageAuthor;
  /** Agente humano autor del reply (07_QUALITY_SUPERVISION.md §6); null en inbound/ai/system. */
  agentId: string | null;
  externalId: string | null;
  body: string;
  type: string;
  mediaId: string | null;
  mimeType: string | null;
  caption: string | null;
  filename: string | null;
  createdAt: Date;
}
