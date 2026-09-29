import { businessError } from "../../../../../shared/errors/domain-errors";
import type { CustomerWithDetails } from "../../domain/customer.entity";
import type {
  CreateCustomerInput,
  CustomerRepositoryPort,
} from "../ports/customer.repository.port";

export class CreateCustomerUseCase {
  constructor(private readonly customerRepo: CustomerRepositoryPort) {}

  async execute(input: CreateCustomerInput): Promise<CustomerWithDetails> {
    const cleanPhone = input.waPhone.trim().replace(/\s+/g, "");

    // Validar teléfono duplicado
    const existingByPhone = await this.customerRepo.findByWaPhone(cleanPhone);
    if (existingByPhone) {
      throw businessError(`Ya existe un contacto con el teléfono ${cleanPhone}`);
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

    // Enlazar conversaciones previas de ese número
    await this.customerRepo.linkConversationByPhone(created.id, cleanPhone);

    return created;
  }
}
