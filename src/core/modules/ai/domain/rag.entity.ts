export interface RagDocument {
  id: string;
  name: string;
  category: string;
  mimeType: string;
  sizeBytes: number;
  status: "pending" | "processing" | "processed" | "error";
  chunksCount: number;
  uploadedBy: string;
  sourceUrl: string | null;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt?: Date;
}

export interface RagFaq {
  id: string;
  category: string;
  question: string;
  answer: string;
  tags: string[];
  variations: string[];
  priority: number;
  active: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface RagChunk {
  id: string;
  sourceName: string;
  contentSnippet: string;
  similarityScore: number;
  section?: string;
}

export interface RagQueryResult {
  answer: string;
  found: boolean;
  confidenceScore: number;
  sources: string[];
  retrievedChunks: RagChunk[];
  executionTimeMs: number;
}

export interface RagStats {
  totalDocuments: number;
  totalVectors: number;
  totalFaqs: number;
}
