import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type {
  ContractRepositoryPort,
  CustomerRepositoryPort,
} from "../ports/customer.repository.port";
import type {
  ConversationIdentityPort,
  RememberValidatedIdentityInput,
  ValidatedIdentitySnapshot,
} from "../ports/conversation-identity.port";

/**
 * Persistencia y lectura de identidad validada por conversación
 * (docs/spec/02_STATE_MACHINE.md §14).
 */
export class ConversationIdentityService implements ConversationIdentityPort {
  constructor(
    private readonly conversationRepo: ConversationRepositoryPort,
    private readonly customerRepo: CustomerRepositoryPort,
    private readonly contractRepo: ContractRepositoryPort,
  ) {}

  async tryGetValidatedIdentity(conversationId: string): Promise<ValidatedIdentitySnapshot | null> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation?.customerId) return null;

    const customer = await this.customerRepo.findById(conversation.customerId);
    if (!customer?.nationalId) return null;

    const contracts = await this.contractRepo.listActiveByCustomerId(customer.id);
    // Solo reutilizamos cuando hay exactamente un contrato activo conocido —
    // varios contratos requerirían desambiguar de nuevo (VALIDATE_CLIENT).
    if (contracts.length !== 1) return null;
    const contract = contracts[0]!;

    return {
      nationalId: customer.nationalId,
      fullName: customer.fullName ?? "",
      contract: {
        id: contract.contractNumber,
        sector: contract.sector ?? "",
        oltName: contract.oltName ?? "",
        pon: contract.pon ?? "",
        serial: contract.serial ?? "",
        ...(contract.routerModel ? { router: contract.routerModel } : {}),
      },
    };
  }

  async rememberValidatedIdentity(input: RememberValidatedIdentityInput): Promise<void> {
    const customer = await this.customerRepo.upsertByNationalId({
      nationalId: input.nationalId,
      fullName: input.fullName,
    });
    await this.contractRepo.upsertByCustomerAndNumber({
      customerId: customer.id,
      contractNumber: input.contract.contractNumber,
      sector: input.contract.sector,
      oltName: input.contract.oltName,
      pon: input.contract.pon,
      serial: input.contract.serial,
      routerModel: input.contract.routerModel,
      status: "active",
    });
    await this.conversationRepo.setCustomerId(input.conversationId, customer.id);
  }
}
