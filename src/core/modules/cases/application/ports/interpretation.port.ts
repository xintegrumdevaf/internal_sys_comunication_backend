/**
 * Subconjunto de `AIProviderPort` (docs/spec/03_API_CONTRACT.md §A) que
 * necesita `CaseArbitrationService` para decidir una transicion. La
 * implementacion real (`OllamaAdapter`) llega en la Etapa 5; en la Etapa 2
 * los tests de arbitraje/motor construyen `Interpretation` a mano
 * ("interpretacion sintetica", docs/spec/05_BUILD_PLAN.md Etapa 2) sin pasar
 * por ningun adapter.
 */
export type InterpretationType =
  | "NEW_INTENT"
  | "CONTINUE"
  | "ANSWER"
  | "CHANGE_TOPIC"
  | "CONFIRM"
  | "DENY"
  | "CANCEL"
  | "REQUEST_HUMAN"
  | "UNCLEAR";

export type Interpretation = {
  type: InterpretationType;
  /** 'support.internet' | 'billing.record_payment' | ... */
  intent: string;
  entities: Record<string, unknown>;
  confidence: number;
};

export type InterpretMessageInput = {
  correlationId: string;
  conversationId: string;
  text: string;
  activeCase: { workflowType: string; pendingQuestion?: string } | null;
};

export interface InterpretationPort {
  interpretMessage(input: InterpretMessageInput): Promise<Interpretation>;
}
