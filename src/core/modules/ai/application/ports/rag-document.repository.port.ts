import type { RagDocument, RagFaq, RagStats } from "../../domain/rag.entity";

export interface CreateRagDocumentInput {
  id: string;
  name: string;
  category: string;
  mimeType: string;
  sizeBytes: number;
  chunksCount: number;
  uploadedBy: string;
  sourceUrl?: string | null;
}

export interface CreateRagFaqInput {
  id: string;
  category: string;
  question: string;
  answer: string;
  tags?: string[];
  variations?: string[];
  priority?: number;
}

export interface UpdateRagFaqInput {
  category?: string;
  question?: string;
  answer?: string;
  tags?: string[];
  variations?: string[];
  priority?: number;
  active?: boolean;
}

export interface RagDocumentRepositoryPort {
  listDocuments(): Promise<RagDocument[]>;
  createDocument(input: CreateRagDocumentInput): Promise<RagDocument>;
  findDocumentById(id: string): Promise<RagDocument | null>;
  deleteDocument(id: string): Promise<boolean>;

  listFaqs(): Promise<RagFaq[]>;
  createFaq(input: CreateRagFaqInput): Promise<RagFaq>;
  updateFaq(id: string, input: UpdateRagFaqInput): Promise<RagFaq | null>;
  deleteFaq(id: string): Promise<boolean>;
  findActiveFaqs(): Promise<RagFaq[]>;

  getStats(): Promise<RagStats>;
}
