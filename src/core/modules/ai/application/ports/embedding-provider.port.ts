export interface EmbeddingProviderPort {
  generateEmbedding(text: string): Promise<number[]>;
  generateBatchEmbeddings?(texts: string[]): Promise<number[][]>;
  getDimension(): number;
  getModelName(): string;
}
