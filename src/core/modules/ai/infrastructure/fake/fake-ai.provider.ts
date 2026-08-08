import type {
  AIProviderPort,
  ComposeReplyInput,
  InterpretMessageInput,
  Interpretation,
  ReceiptData,
} from "../../application/ports/ai-provider.port";

/**
 * Fake inyectable para tests de Etapa 5 (docs/spec/05_BUILD_PLAN.md aceptacion).
 */
export class FakeAIProvider implements AIProviderPort {
  interpretImpl: (input: InterpretMessageInput) => Promise<Interpretation> = async () => ({
    type: "UNCLEAR",
    intent: "unknown",
    entities: {},
    confidence: 0,
  });

  composeImpl: (input: ComposeReplyInput) => Promise<string> = async (input) =>
    input.templateHint?.trim() || "Mensaje de negocio.";

  transcribeImpl: (mediaUrl: string, mimeType: string) => Promise<{ transcript: string }> = async () => ({
    transcript: "",
  });

  extractReceiptImpl: (mediaUrl: string, mimeType: string) => Promise<ReceiptData> = async () => ({});

  async interpretMessage(input: InterpretMessageInput): Promise<Interpretation> {
    return this.interpretImpl(input);
  }

  async composeReply(input: ComposeReplyInput): Promise<string> {
    return this.composeImpl(input);
  }

  async transcribeAudio(mediaUrl: string, mimeType: string): Promise<{ transcript: string }> {
    return this.transcribeImpl(mediaUrl, mimeType);
  }

  async extractReceiptData(mediaUrl: string, mimeType: string): Promise<ReceiptData> {
    return this.extractReceiptImpl(mediaUrl, mimeType);
  }
}
