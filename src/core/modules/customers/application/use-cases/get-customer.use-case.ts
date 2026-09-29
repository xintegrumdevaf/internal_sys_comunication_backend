import { notFound } from "../../../../../shared/errors/domain-errors";
import type { CustomerWithDetails } from "../../domain/customer.entity";
import type { CustomerRepositoryPort } from "../ports/customer.repository.port";

export class GetCustomerUseCase {
  constructor(private readonly customerRepo: CustomerRepositoryPort) {}

  async execute(id: string): Promise<CustomerWithDetails> {
    const customer = await this.customerRepo.findWithDetailsById(id);
    if (!customer) {
      throw notFound(`Contacto/Cliente con id '${id}' no encontrado`);
    }
    return customer;
  }
}
