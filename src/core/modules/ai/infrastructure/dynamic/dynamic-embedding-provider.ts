import type { EmbeddingProviderPort } from "../../application/ports/embedding-provider.port";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";

/**
 * Proveedor de embeddings dinámico que conmuta entre Gemini y Ollama
 * según la configuración activa en base de datos sin requerir redespliegue.
 */
export class DynamicEmbeddingProvider implements EmbeddingProviderPort {
  private currentProviderName: "gemini" | "ollama" = "gemini";

  constructor(
    private readonly settingsService: SystemSettingsService,
    private readonly geminiEmbedding: EmbeddingProviderPort,
    private readonly ollamaEmbedding: EmbeddingProviderPort,
  ) {}

  private async getProvider(): Promise<EmbeddingProviderPort> {
    try {
      const settings = await this.settingsService.getAiSettings();
      this.currentProviderName = settings.provider;
      if (settings.provider === "ollama") {
        return this.ollamaEmbedding;
      }
      return this.geminiEmbedding;
    } catch {
      return this.geminiEmbedding;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const provider = await this.getProvider();
    return provider.generateEmbedding(text);
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const provider = await this.getProvider();
    if (provider.generateBatchEmbeddings) {
      return provider.generateBatchEmbeddings(texts);
    }
    return Promise.all(texts.map((t) => provider.generateEmbedding(t)));
  }

  getDimension(): number {
    return this.currentProviderName === "ollama"
      ? this.ollamaEmbedding.getDimension()
      : this.geminiEmbedding.getDimension();
  }

  getModelName(): string {
    return this.currentProviderName === "ollama"
      ? this.ollamaEmbedding.getModelName()
      : this.geminiEmbedding.getModelName();
  }
}
