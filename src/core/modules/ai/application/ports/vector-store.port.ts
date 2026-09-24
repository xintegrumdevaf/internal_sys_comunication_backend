import type { RagChunk } from "../../domain/rag.entity";

export interface IndexChunkInput {
  text: string;
  embedding: number[];
  metadata: {
    source: string;
    filename: string;
    chunkIndex: number;
    section?: string;
    departmentId?: string | null;
    isGlobal?: boolean;
  };
}

export interface HybridSearchInput {
  embedding: number[];
  keywords: string[];
  limit: number;
  departmentId?: string | null;
}

export interface VectorStorePort {
  indexChunks(chunks: IndexChunkInput[]): Promise<number>;
  deleteBySource(sourceName: string): Promise<void>;
  searchHybrid(input: HybridSearchInput): Promise<RagChunk[]>;
  countVectors(): Promise<number>;
}
