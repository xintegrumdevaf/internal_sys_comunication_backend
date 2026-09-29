import type {
  ConversationIdentityPort,
  RememberCustomerContractsInput,
  RememberValidatedIdentityInput,
  ValidatedIdentitySnapshot,
} from "../../src/core/modules/customers/application/ports/conversation-identity.port";

/** Fake en memoria de §14 para tests de workflow / AdvanceCase. */
export class ConversationIdentityFake implements ConversationIdentityPort {
  readonly byConversation = new Map<string, ValidatedIdentitySnapshot>();
  rememberCalls = 0;
  tryGetCalls = 0;

  seed(conversationId: string, snapshot: ValidatedIdentitySnapshot): void {
    this.byConversation.set(conversationId, snapshot);
  }

  async tryGetValidatedIdentity(conversationId: string): Promise<ValidatedIdentitySnapshot | null> {
    this.tryGetCalls += 1;
    return this.byConversation.get(conversationId) ?? null;
  }

  async rememberValidatedIdentity(input: RememberValidatedIdentityInput): Promise<void> {
    this.rememberCalls += 1;
    this.byConversation.set(input.conversationId, {
      nationalId: input.nationalId,
      fullName: input.fullName,
      contract: {
        id: input.contract.contractNumber,
        sector: input.contract.sector ?? "",
        oltName: input.contract.oltName ?? "",
        pon: input.contract.pon ?? "",
        serial: input.contract.serial ?? "",
        ...(input.contract.routerModel ? { router: input.contract.routerModel } : {}),
      },
    });
  }

  async rememberCustomerContracts(input: RememberCustomerContractsInput): Promise<void> {
    this.rememberCalls += 1;
    if (input.contracts.length > 0) {
      const first = input.contracts[0]!;
      this.byConversation.set(input.conversationId, {
        nationalId: input.nationalId,
        fullName: input.fullName,
        contract: {
          id: first.contractNumber,
          sector: first.sector ?? "",
          oltName: first.oltName ?? "",
          pon: first.pon ?? "",
          serial: first.serial ?? "",
          ...(first.routerModel ? { router: first.routerModel } : {}),
        },
      });
    }
  }
}
