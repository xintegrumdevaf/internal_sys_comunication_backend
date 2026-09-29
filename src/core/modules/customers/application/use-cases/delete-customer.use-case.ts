import { notFound } from "../../../../../shared/errors/domain-errors";
import type { CustomerRepositoryPort } from "../ports/customer.repository.port";

export class DeleteCustomerUseCase {
  constructor(private readonly customerRepo: CustomerRepositoryPort) {}

  async execute(id: string): Promise<void> {
    const existing = await this.customerRepo.findById(id);
    if (!existing) {
      throw notFound(`Contacto/Cliente con id '${id}' no encontrado`);
    }

    const deleted = await this.customerRepo.delete(id);
    if (!deleted) {
      throw notFound(`No se pudo eliminar el contacto con id '${id}'`);
    }
  }
}
