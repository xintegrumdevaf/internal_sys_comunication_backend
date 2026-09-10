import type { EmbeddingProviderPort } from "../../application/ports/embedding-provider.port";
import type { Logger } from "../../../../../shared/logging/logger";

export interface GeminiEmbeddingConfig {
  apiKey: string;
  model?: string;
  dimension?: number;
}

export class GeminiEmbeddingAdapter implements EmbeddingProviderPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimension: number;

  constructor(config: GeminiEmbeddingConfig, private readonly logger?: Logger) {
    this.apiKey = config.apiKey;
    this.model = config.model || "gemini-embedding-2";
    this.dimension = config.dimension || 768;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
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
    return this.dimension;
  }

  getModelName(): string {
    return `gemini:${this.model}`;
  }
}
