export type MessageDirection = "inbound" | "outbound";
export type MessageAuthor = "customer" | "ai" | "agent" | "system";
export type MessageStatus = "sent" | "delivered" | "read" | "failed";

export interface MessageEditHistoryEntry {
  previousBody: string;
  editedAt: string;
}

export interface QuotedMessagePreview {
  id: string;
  externalId?: string | null;
  author: MessageAuthor;
  body: string;
  type: string;
  mediaId?: string | null;
  caption?: string | null;
  filename?: string | null;
  agentName?: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  caseId: string | null;
  direction: MessageDirection;
  author: MessageAuthor;
  /** Agente humano autor del reply (07_QUALITY_SUPERVISION.md §6); null en inbound/ai/system. */
  agentId: string | null;
  /** Nombre del agente autor (resuelto por join con agent.name); null en inbound/ai/system. */
  agentName?: string | null;
  externalId: string | null;
  body: string;
  type: string;
  mediaId: string | null;
  mimeType: string | null;
  caption: string | null;
  filename: string | null;
  status: MessageStatus;
  errorMessage: string | null;
  replyToExternalId?: string | null;
  replyToMessageId?: string | null;
  /** Vista previa del mensaje citado para renderizar en la UI tipo WhatsApp. */
  replyTo?: QuotedMessagePreview | null;
  /** Indica si el mensaje fue marcado como reenviado en WhatsApp. */
  isForwarded?: boolean;
  editedAt?: Date | null;
  editHistory?: MessageEditHistoryEntry[];
  createdAt: Date;
}

