import type { Conversation, ConversationStatus } from "../../domain/conversation.entity";

export type ListConversationsFilter = {
  status?: ConversationStatus;
};

export interface ConversationRepositoryPort {
  findById(id: string): Promise<Conversation | null>;
  findByWaPhone(waPhone: string): Promise<Conversation | null>;
  /** Atomico solo si el llamador ya sostiene el lock de docs/spec 00 §3 (ver withConversationLock). */
  findOrCreateByWaPhone(waPhone: string): Promise<Conversation>;
  touchLastActivity(id: string): Promise<void>;
  list(filter: ListConversationsFilter): Promise<Conversation[]>;
  /**
   * docs/spec/01_DATA_MODEL.md §3: `active_case_id` solo puede apuntar a un
   * `case` en ACTIVE/WAITING_USER — invariante validada por quien orquesta
   * la transicion (`CaseArbitrationService`/`AdvanceCaseUseCase`), no aqui.
   */
  setActiveCaseId(id: string, caseId: string | null): Promise<void>;
  /**
   * docs/spec/02_STATE_MACHINE.md §14: fija el Customer ya validado en esta
   * conversación para no volver a pedir cédula en casos posteriores.
   */
  setCustomerId(id: string, customerId: string | null): Promise<void>;
  /**
   * Nombre de perfil de WhatsApp (`contacts[].profile.name` del webhook de
   * Meta) — se actualiza en cada mensaje entrante que lo traiga, nunca se
   * borra con un valor vacío (la persona puede cambiarlo, pero un mensaje
   * sin `contacts` no debe pisar el último nombre conocido).
   */
  setWaProfileName(id: string, name: string): Promise<void>;
}
