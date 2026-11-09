/**
 * Subconjunto de AIProviderPort para cases (docs/spec/03_API_CONTRACT.md §A).
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
  intent: string;
  entities: Record<string, unknown>;
  confidence: number;
};

export type PreviousCompletedCaseContext = {
  workflowType: string;
  closeReason?: string;
  resolutionNote?: string | null;
  closedMinutesAgo?: number;
  summary?: string;
};

export type InterpretMessageInput = {
  correlationId: string;
  conversationId: string;
  text: string;
  messageId?: string;
  activeCase: {
    workflowType: string;
    pendingQuestion?: string;
    requireAll?: string[];
    requireAny?: string[];
  } | null;
  recentMessages?: Array<{ author: string; body: string }>;
  previousCompletedCase?: PreviousCompletedCaseContext | null;
};

export interface InterpretationPort {
  interpretMessage(input: InterpretMessageInput): Promise<Interpretation>;
}
