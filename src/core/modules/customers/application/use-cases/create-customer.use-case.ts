import { businessError } from "../../../../../shared/errors/domain-errors";
import type { CustomerWithDetails } from "../../domain/customer.entity";
import type {
  CreateCustomerInput,
  CustomerRepositoryPort,
} from "../ports/customer.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";

export class CreateCustomerUseCase {
  constructor(
    private readonly customerRepo: CustomerRepositoryPort,
    private readonly conversationRepo?: ConversationRepositoryPort,
  ) {}

  async execute(input: CreateCustomerInput): Promise<CustomerWithDetails> {
    const cleanPhone = input.waPhone ? input.waPhone.trim().replace(/\s+/g, "") : null;

    // Validar teléfono duplicado
    if (cleanPhone) {
      const existingByPhone = await this.customerRepo.findByWaPhone(cleanPhone);
      if (existingByPhone) {
        throw businessError(`Ya existe un contacto con el teléfono ${cleanPhone}`);
      }
    }

    // Validar cédula duplicada si viene especificada
    const cleanNationalId = input.nationalId?.trim() || null;
    if (cleanNationalId) {
      const existingByNationalId = await this.customerRepo.findByNationalId(cleanNationalId);
      if (existingByNationalId) {
        throw businessError(`Ya existe un cliente con la cédula ${cleanNationalId}`);
      }
    }

    const created = await this.customerRepo.create({
      ...input,
      fullName: input.fullName.trim(),
      waPhone: cleanPhone,
      nationalId: cleanNationalId,
      email: input.email?.trim() || null,
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
    });

    // Enlazar conversaciones previas de ese numero
    if (cleanPhone) {
      await this.customerRepo.linkConversationByPhone(created.id, cleanPhone);

      if (this.conversationRepo) {
        const digitsPhone = cleanPhone.replace(/\D/g, "") || cleanPhone;
        const conv = await this.conversationRepo.findOrCreateByWaPhone(digitsPhone);
        if (conv.customerId !== created.id) {
          await this.conversationRepo.setCustomerId(conv.id, created.id);
        }
        return (await this.customerRepo.findWithDetailsById(created.id)) ?? created;
      }
    }

    return created;
  }
}