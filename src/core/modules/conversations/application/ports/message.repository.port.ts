import type { Message, MessageAuthor } from "../../domain/message.entity";

export type InsertInboundMessageInput = {
  conversationId: string;
  externalId: string;
  body: string;
  type: string;
  mediaId?: string | null;
  mimeType?: string | null;
  caption?: string | null;
  filename?: string | null;
};

export type InsertOutboundMessageInput = {
  conversationId: string;
  author: MessageAuthor;
  body: string;
  externalId?: string | null;
};

export interface MessageRepositoryPort {
  /**
   * Idempotente por UNIQUE(conversation_id, external_id) — docs/spec/01_DATA_MODEL.md §3.
   * Si el mensaje ya existia, devuelve el registro existente con isDuplicate=true
   * en vez de lanzar o duplicar.
   */
  insertInbound(input: InsertInboundMessageInput): Promise<{ message: Message; isDuplicate: boolean }>;
  insertOutbound(input: InsertOutboundMessageInput): Promise<Message>;
  listByConversation(conversationId: string): Promise<Message[]>;
  /** Usado por el buffer/debounce (docs/spec/02_STATE_MACHINE.md §12) para recuperar la unidad de trabajo agrupada. */
  findByIds(ids: string[]): Promise<Message[]>;
}
