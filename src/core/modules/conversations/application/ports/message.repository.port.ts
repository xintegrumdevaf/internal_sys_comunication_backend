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
  /** Reply humano: agente de la sesion (07_QUALITY_SUPERVISION.md §6). */
  agentId?: string | null;
  /** Caso activo de la conversacion al momento del reply, si existe. */
  caseId?: string | null;
};

export type ListMessagesOptions = {
  limit?: number;
  /** Cursor = createdAt ISO del último mensaje visto (paginación hacia atrás en el tiempo). */
  cursor?: string;
};

export interface MessageRepositoryPort {
  /**
   * Idempotente por UNIQUE(conversation_id, external_id) — docs/spec/01_DATA_MODEL.md §3.
   * Si el mensaje ya existia, devuelve el registro existente con isDuplicate=true
   * en vez de lanzar o duplicar.
   */
  insertInbound(input: InsertInboundMessageInput): Promise<{ message: Message; isDuplicate: boolean }>;
  insertOutbound(input: InsertOutboundMessageInput): Promise<Message>;
  listByConversation(conversationId: string, options?: ListMessagesOptions): Promise<Message[]>;
  /** Usado por el buffer/debounce (docs/spec/02_STATE_MACHINE.md §12) para recuperar la unidad de trabajo agrupada. */
  findByIds(ids: string[]): Promise<Message[]>;
  /** Último mensaje por conversación (01_DATA_MODEL.md §6 lastMessagePreview). */
  findLastByConversationIds(conversationIds: string[]): Promise<Map<string, Message>>;
  /**
   * Ventana de mensajes de un caso para analisis de calidad
   * (07_QUALITY_SUPERVISION.md §4.3) — solo autores indicados, orden cronologico.
   */
  listByCaseAuthors(
    caseId: string,
    authors: Array<"customer" | "agent">,
  ): Promise<Message[]>;
  /**
   * Agentes distintos que enviaron mensajes en el caso (para análisis de calidad multi-agente).
   */
  listDistinctAgentIdsByCase(caseId: string): Promise<string[]>;
}

