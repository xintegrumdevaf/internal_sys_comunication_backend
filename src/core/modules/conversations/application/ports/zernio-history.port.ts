import type {
  ZernioHistoricalConversation,
  ZernioHistoricalMessage,
} from "../../domain/zernio-history.types";

export interface ZernioHistoryPort {
  /**
   * Obtiene la lista completa de conversaciones históricas en Zernio,
   * resolviendo internamente la paginación con cursor si aplica.
   */
  fetchAllConversations(): Promise<ZernioHistoricalConversation[]>;

  /**
   * Obtiene todos los mensajes de una conversación histórica en Zernio,
   * resolviendo internamente la paginación con cursor si aplica.
   */
  fetchMessagesForConversation(zernioConversationId: string): Promise<ZernioHistoricalMessage[]>;
}
