import type {
  AIProviderPort,
  AnalyzeAgentConversationInput,
  ComposeReplyInput,
  InterpretMessageInput,
  Interpretation,
  QualityAnalysis,
  ReceiptData,
  RefineTextToneInput,
  RefineTextToneOutput,
} from "../../application/ports/ai-provider.port";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";

/**
 * Proveedor de IA dinámico que delega la ejecución al proveedor activo configurado
 * en base de datos (Gemini u Ollama) sin requerir redespliegue ni reinicio.
 */
export class DynamicAiProvider implements AIProviderPort {
  constructor(
    private readonly settingsService: SystemSettingsService,
    private readonly geminiProvider: AIProviderPort,
    private readonly ollamaProvider: AIProviderPort,
  ) {}

  private async getActiveProvider(): Promise<AIProviderPort> {
    try {
      const settings = await this.settingsService.getAiSettings();
      if (settings.provider === "ollama") {
        return this.ollamaProvider;
      }
      return this.geminiProvider;
    } catch {
      return this.geminiProvider;
    }
  }

  async interpretMessage(input: InterpretMessageInput): Promise<Interpretation> {
    const provider = await this.getActiveProvider();
    return provider.interpretMessage(input);
  }

  async composeReply(input: ComposeReplyInput): Promise<string> {
    const provider = await this.getActiveProvider();
    return provider.composeReply(input);
  }

  async transcribeAudio(mediaUrl: string, mimeType: string): Promise<{ transcript: string }> {
    const provider = await this.getActiveProvider();
    return provider.transcribeAudio(mediaUrl, mimeType);
  }

  async extractReceiptData(mediaUrl: string, mimeType: string): Promise<ReceiptData> {
    const provider = await this.getActiveProvider();
    return provider.extractReceiptData(mediaUrl, mimeType);
  }

  async analyzeAgentConversation(input: AnalyzeAgentConversationInput): Promise<QualityAnalysis> {
    const provider = await this.getActiveProvider();
    return provider.analyzeAgentConversation(input);
  }

  async refineTextTone(input: RefineTextToneInput): Promise<RefineTextToneOutput> {
    const provider = await this.getActiveProvider();
    return provider.refineTextTone(input);
  }
}
