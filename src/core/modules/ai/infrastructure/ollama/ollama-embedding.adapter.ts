import type { EmbeddingProviderPort } from "../../application/ports/embedding-provider.port";
import type { Logger } from "../../../../../shared/logging/logger";

export interface OllamaEmbeddingConfig {
  baseUrl: string;
  model: string;
  dimension?: number;
}

export class OllamaEmbeddingAdapter implements EmbeddingProviderPort {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimension: number;

  constructor(config: OllamaEmbeddingConfig, private readonly logger?: Logger) {
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    // Default dimension for qwen3-embedding:4b is 2560
    this.dimension = config.dimension || 2560;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const url = `${this.baseUrl}/api/embeddings`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ model: this.model, prompt: text }),
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
    return this.dimension;
  }

  getModelName(): string {
    return `ollama:${this.model}`;
  }
}
