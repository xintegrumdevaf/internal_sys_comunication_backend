import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { CustomerRepositoryPort } from "../ports/customer.repository.port";

export type OpenOrCreateCustomerConversationResult = {
  conversationId: string;
  customerId: string;
  waPhone: string;
  status: string;
};

/**
 * Abre o crea la conversación de un contacto en el backend.
 * Permite que un operador abra el chat de un cliente inmediatamente
 * (incluso si está vacío) mientras la migración de historial de WhatsApp/Zernio
 * aún se encuentra procesando en segundo plano.
 */
export class OpenOrCreateCustomerConversationUseCase {
  constructor(
    private readonly customerRepo: CustomerRepositoryPort,
    private readonly conversationRepo: ConversationRepositoryPort,
  ) {}

  async execute(customerId: string): Promise<OpenOrCreateCustomerConversationResult> {
    const customer = await this.customerRepo.findById(customerId);
    if (!customer) {
      throw notFound(`Contacto ${customerId} no encontrado`);
    }

    if (!customer.waPhone || customer.waPhone.trim() === "") {
      throw businessError("El contacto no tiene un número de WhatsApp registrado");
    }

    const digitsPhone = customer.waPhone.replace(/\D/g, "");
    if (!digitsPhone || digitsPhone.length < 6) {
      throw businessError("El número de WhatsApp del contacto debe tener al menos 6 dígitos numéricos");
    }

    const conversation = await this.conversationRepo.findOrCreateByWaPhone(digitsPhone);
    if (conversation.customerId !== customer.id) {
      await this.conversationRepo.setCustomerId(conversation.id, customer.id);
    }
    await this.customerRepo.linkConversationByPhone(customer.id, digitsPhone);

    return {
      conversationId: conversation.id,
      customerId: customer.id,
      waPhone: conversation.waPhone,
      status: conversation.status,
    };
  }
}
