import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { CustomerWithDetails } from "../../domain/customer.entity";
import type {
  CustomerRepositoryPort,
  UpdateCustomerInput,
} from "../ports/customer.repository.port";

export class UpdateCustomerUseCase {
  constructor(private readonly customerRepo: CustomerRepositoryPort) {}

  async execute(id: string, input: UpdateCustomerInput): Promise<CustomerWithDetails> {
    const existing = await this.customerRepo.findById(id);
    if (!existing) {
      throw notFound(`Contacto/Cliente con id '${id}' no encontrado`);
    }

    if (input.waPhone !== undefined && input.waPhone !== null) {
      const cleanPhone = input.waPhone.trim().replace(/\s+/g, "");
      const byPhone = await this.customerRepo.findByWaPhone(cleanPhone);
      if (byPhone && byPhone.id !== id) {
        throw businessError(`El teléfono ${cleanPhone} ya pertenece a otro contacto`);
      }
    }

    if (input.nationalId !== undefined && input.nationalId !== null && input.nationalId.trim() !== "") {
      const cleanNationalId = input.nationalId.trim();
      const byNationalId = await this.customerRepo.findByNationalId(cleanNationalId);
      if (byNationalId && byNationalId.id !== id) {
        throw businessError(`La cédula ${cleanNationalId} ya pertenece a otro cliente`);
      }
    }

    const updated = await this.customerRepo.update(id, {
      ...input,
      fullName: input.fullName !== undefined ? input.fullName?.trim() || null : undefined,
      waPhone: input.waPhone !== undefined ? input.waPhone?.trim().replace(/\s+/g, "") || null : undefined,
      nationalId: input.nationalId !== undefined ? input.nationalId?.trim() || null : undefined,
      email: input.email !== undefined ? input.email?.trim() || null : undefined,
      address: input.address !== undefined ? input.address?.trim() || null : undefined,
      notes: input.notes !== undefined ? input.notes?.trim() || null : undefined,
    });

    if (!updated) {
      throw notFound(`No se pudo actualizar el contacto con id '${id}'`);
    }

    if (updated.waPhone) {
      await this.customerRepo.linkConversationByPhone(updated.id, updated.waPhone);
    }

    return updated;
  }
}
