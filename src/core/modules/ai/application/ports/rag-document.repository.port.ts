import type { RagDocument, RagFaq, RagStats } from "../../domain/rag.entity";

export interface CreateRagDocumentInput {
  id: string;
  name: string;
  category: string;
  departmentId?: string | null;
  isGlobal?: boolean;
  mimeType: string;
  sizeBytes: number;
  chunksCount: number;
  uploadedBy: string;
  sourceUrl?: string | null;
}

export interface CreateRagFaqInput {
  id: string;
  category: string;
  departmentId?: string | null;
  isGlobal?: boolean;
  question: string;
  answer: string;
  tags?: string[];
  variations?: string[];
  priority?: number;
}

export interface UpdateRagFaqInput {
  category?: string;
  departmentId?: string | null;
  isGlobal?: boolean;
  question?: string;
  answer?: string;
  tags?: string[];
  variations?: string[];
  priority?: number;
  active?: boolean;
}

export interface RagDocumentRepositoryPort {
  listDocuments(filter?: { departmentId?: string }): Promise<RagDocument[]>;
  createDocument(input: CreateRagDocumentInput): Promise<RagDocument>;
  findDocumentById(id: string): Promise<RagDocument | null>;
  deleteDocument(id: string): Promise<boolean>;

  listFaqs(filter?: { departmentId?: string }): Promise<RagFaq[]>;
  createFaq(input: CreateRagFaqInput): Promise<RagFaq>;
  updateFaq(id: string, input: UpdateRagFaqInput): Promise<RagFaq | null>;
  deleteFaq(id: string): Promise<boolean>;
  findActiveFaqs(filter?: { departmentId?: string }): Promise<RagFaq[]>;

  getStats(): Promise<RagStats>;
}
