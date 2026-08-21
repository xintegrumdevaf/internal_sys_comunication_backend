export type ConversationStatus = "open" | "pending" | "resolved" | "closed";

export interface Conversation {
  id: string;
  waPhone: string;
  customerId: string | null;
  activeCaseId: string | null;
  status: ConversationStatus;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Nombre de perfil/agenda de WhatsApp (viene gratis en cada webhook
   * `null` hasta que llegue el primer mensaje con `contacts` en el payload.
   */
  waProfileName: string | null;
  unreadCount: number;
}
