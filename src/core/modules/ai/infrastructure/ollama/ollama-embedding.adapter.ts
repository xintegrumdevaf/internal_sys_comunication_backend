import type { EmbeddingProviderPort } from "../../application/ports/embedding-provider.port";
import type { Logger } from "../../../../../shared/logging/logger";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";

export interface OllamaEmbeddingConfig {
  baseUrl: string;
  model: string;
  dimension?: number;
}

export class OllamaEmbeddingAdapter implements EmbeddingProviderPort {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimension: number;
  private currentModel: string;
  private currentDimension: number;
  private currentBaseUrl: string;

  constructor(
    config: OllamaEmbeddingConfig,
    private readonly logger?: Logger,
    private readonly settingsService?: SystemSettingsService,
  ) {
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    // Default dimension for qwen3-embedding:4b is 2560
    this.dimension = config.dimension || 2560;
    this.currentModel = this.model;
    this.currentDimension = this.dimension;
    this.currentBaseUrl = this.baseUrl;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    let baseUrl = this.currentBaseUrl;
    let model = this.currentModel;

    if (this.settingsService) {
      try {
        const s = await this.settingsService.getAiSettings();
        if (s.ollamaBaseUrl) {
          baseUrl = s.ollamaBaseUrl;
          this.currentBaseUrl = baseUrl;
        }
        if (s.ollamaEmbeddingModel) {
          model = s.ollamaEmbeddingModel;
          this.currentModel = model;
        }
        if (s.ollamaEmbeddingDimension) {
          this.currentDimension = s.ollamaEmbeddingDimension;
        }
      } catch {
        // Fallback a config inicial
      }
    }

    try {
      const url = `${baseUrl}/api/embeddings`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ model, prompt: text, keep_alive: "24h" }),
        });

        if (res.ok) {
          const data = (await res.json()) as { embedding: number[] };
          if (Array.isArray(data.embedding) && data.embedding.length > 0) {
            return data.embedding;
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      this.logger?.warn({ err, textSnippet: text.slice(0, 40) }, "Ollama embedding no disponible, usando pseudo-vector fallback");
    }

    return this.generatePseudoEmbedding(text);
  }

  private generatePseudoEmbedding(text: string): number[] {
    const vector = new Array<number>(this.dimension).fill(0);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    for (let i = 0; i < this.dimension; i++) {
      const val = Math.sin(hash + i) * 10000;
      vector[i] = Number((val - Math.floor(val) - 0.5).toFixed(6));
    }
    return vector;
  }

  getDimension(): number {
    return this.currentDimension;
  }

  getModelName(): string {
    return `ollama:${this.currentModel}`;
  }
}
