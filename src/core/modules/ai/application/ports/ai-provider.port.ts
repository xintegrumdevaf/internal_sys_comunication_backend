/**
 * Contrato interno de IA (docs/spec/03_API_CONTRACT.md §A).
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

export type InterpretMessageInput = {
  correlationId: string;
  conversationId: string;
  messageId: string;
  text: string;
  conversationSnapshot: {
    activeCase?: {
      workflowType: string;
      pendingQuestion?: string;
      requireAll?: string[];
      requireAny?: string[];
    };
  };
};

export type ComposeReplyInput = {
  caseId: string;
  workflowType: string;
  stepOutcome: {
    action: string;
    status: "COMPLETED" | "FAILED" | "WAITING_USER" | "ESCALATED" | "ACTIVE" | "CLARIFY" | "REQUEST_HUMAN";
    result?: Record<string, unknown>;
  };
  templateHint?: string;
  missingFields?: string[];
};

export type ReceiptData = {
  amount?: number;
  reference?: string;
  date?: string;
};

export interface AIProviderPort {
  interpretMessage(input: InterpretMessageInput): Promise<Interpretation>;
  composeReply(input: ComposeReplyInput): Promise<string>;
  transcribeAudio(mediaUrl: string, mimeType: string): Promise<{ transcript: string }>;
  extractReceiptData(mediaUrl: string, mimeType: string): Promise<ReceiptData>;
}
