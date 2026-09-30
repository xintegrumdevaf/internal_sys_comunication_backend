import type { EmbeddingProviderPort } from "../../application/ports/embedding-provider.port";
import type { Logger } from "../../../../../shared/logging/logger";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";

export interface GeminiEmbeddingConfig {
  apiKey: string;
  model?: string;
  dimension?: number;
}

export class GeminiEmbeddingAdapter implements EmbeddingProviderPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimension: number;
  private currentModel: string;
  private currentDimension: number;

  constructor(
    config: GeminiEmbeddingConfig,
    private readonly logger?: Logger,
    private readonly settingsService?: SystemSettingsService,
  ) {
    this.apiKey = config.apiKey;
    this.model = config.model || "text-embedding-004";
    this.dimension = config.dimension || 768;
    this.currentModel = this.model;
    this.currentDimension = this.dimension;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    let apiKey = this.apiKey;
    let model = this.currentModel;

    if (this.settingsService) {
      try {
        const s = await this.settingsService.getAiSettings();
        if (s.geminiApiKey) apiKey = s.geminiApiKey;
        if (s.geminiEmbeddingModel) {
          model = s.geminiEmbeddingModel;
          this.currentModel = model;
        }
        if (s.geminiEmbeddingDimension) {
          this.currentDimension = s.geminiEmbeddingDimension;
        }
      } catch {
        // Fallback a config inicial
      }
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: {
          parts: [{ text }],
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      this.logger?.error({ status: res.status, errText }, "Error llamando a Gemini embeddings");
      throw new Error(`Gemini embeddings HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { embedding?: { values?: number[] } };
    const values = data.embedding?.values;
    if (!Array.isArray(values)) {
      throw new Error("Gemini no retorno un array de embedding valido");
    }
    return values;
  }

  getDimension(): number {
    return this.currentDimension;
  }

  getModelName(): string {
    return `gemini:${this.currentModel}`;
  }
}
