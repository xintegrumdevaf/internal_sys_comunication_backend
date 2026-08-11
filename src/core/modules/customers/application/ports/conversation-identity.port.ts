/**
 * Identidad ya validada en la conversación (docs/spec/02_STATE_MACHINE.md §14).
 * Los handlers de VALIDATE_CLIENT dependen de este puerto — no de repos concretos.
 */
export type ValidatedIdentitySnapshot = {
  nationalId: string;
  fullName: string;
  contract: {
    /** Número / id de contrato (contract.contract_number). */
    id: string;
    sector: string;
    oltName: string;
    pon: string;
    serial: string;
    router?: string;
  };
};

export type RememberValidatedIdentityInput = {
  conversationId: string;
  nationalId: string;
  fullName: string;
  contract: {
    contractNumber: string;
    sector?: string | null;
    oltName?: string | null;
    pon?: string | null;
    serial?: string | null;
    routerModel?: string | null;
  };
};

export interface ConversationIdentityPort {
  tryGetValidatedIdentity(conversationId: string): Promise<ValidatedIdentitySnapshot | null>;
  rememberValidatedIdentity(input: RememberValidatedIdentityInput): Promise<void>;
}
