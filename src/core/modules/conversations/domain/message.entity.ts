export type MessageDirection = "inbound" | "outbound";
export type MessageAuthor = "customer" | "ai" | "agent" | "system";

export interface Message {
  id: string;
  conversationId: string;
  caseId: string | null;
  direction: MessageDirection;
  author: MessageAuthor;
  externalId: string | null;
  body: string;
  type: string;
  mediaId: string | null;
  mimeType: string | null;
  caption: string | null;
  filename: string | null;
  createdAt: Date;
}
