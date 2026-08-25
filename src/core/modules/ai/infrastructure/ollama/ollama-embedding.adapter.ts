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
    const url = `${this.baseUrl}/api/embeddings`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      this.logger?.error({ status: res.status, errText }, "Error llamando a Ollama embeddings");
      throw new Error(`Ollama embeddings HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { embedding: number[] };
    if (!Array.isArray(data.embedding)) {
      throw new Error("Ollama no retorno un array de embedding valido");
    }
    return data.embedding;
  }

  getDimension(): number {
    return this.dimension;
  }

  getModelName(): string {
    return `ollama:${this.model}`;
  }
}
