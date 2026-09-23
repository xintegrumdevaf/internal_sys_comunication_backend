import { describe, expect, it } from "vitest";
import type { RagDocument, RagFaq, RagChunk } from "../../src/core/modules/ai/domain/rag.entity";
import type {
  CreateRagDocumentInput,
  CreateRagFaqInput,
  RagDocumentRepositoryPort,
  UpdateRagFaqInput,
} from "../../src/core/modules/ai/application/ports/rag-document.repository.port";
import type { VectorStorePort, HybridSearchInput, IndexChunkInput } from "../../src/core/modules/ai/application/ports/vector-store.port";
import type { EmbeddingProviderPort } from "../../src/core/modules/ai/application/ports/embedding-provider.port";
import { RagService } from "../../src/core/modules/ai/application/services/rag.service";

class FakeRagDocumentRepository implements RagDocumentRepositoryPort {
  documents: RagDocument[] = [];
  faqs: RagFaq[] = [];

  async listDocuments(filter?: { departmentId?: string }): Promise<RagDocument[]> {
    if (!filter?.departmentId) return [...this.documents];
    return this.documents.filter((d) => d.departmentId === filter.departmentId || d.isGlobal);
  }

  async createDocument(input: CreateRagDocumentInput): Promise<RagDocument> {
    const doc: RagDocument = {
      id: input.id,
      name: input.name,
      category: input.category,
      departmentId: input.departmentId ?? null,
      isGlobal: input.isGlobal ?? false,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      chunksCount: input.chunksCount,
      uploadedBy: input.uploadedBy,
      sourceUrl: input.sourceUrl ?? null,
      status: "processed",
      createdAt: new Date(),
    };
    this.documents.push(doc);
    return doc;
  }

  async findDocumentById(id: string): Promise<RagDocument | null> {
    return this.documents.find((d) => d.id === id) ?? null;
  }

  async deleteDocument(id: string): Promise<boolean> {
    const idx = this.documents.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    this.documents.splice(idx, 1);
    return true;
  }

  async listFaqs(filter?: { departmentId?: string }): Promise<RagFaq[]> {
    if (!filter?.departmentId) return [...this.faqs];
    return this.faqs.filter((f) => f.departmentId === filter.departmentId || f.isGlobal);
  }

  async createFaq(input: CreateRagFaqInput): Promise<RagFaq> {
    const faq: RagFaq = {
      id: input.id,
      category: input.category,
      departmentId: input.departmentId ?? null,
      isGlobal: input.isGlobal ?? false,
      question: input.question,
      answer: input.answer,
      tags: input.tags ?? [],
      variations: input.variations ?? [],
      priority: input.priority ?? 5,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.faqs.push(faq);
    return faq;
  }

  async updateFaq(id: string, input: UpdateRagFaqInput): Promise<RagFaq | null> {
    const faq = this.faqs.find((f) => f.id === id);
    if (!faq) return null;
    Object.assign(faq, input, { updatedAt: new Date() });
    return faq;
  }

  async deleteFaq(id: string): Promise<boolean> {
    const idx = this.faqs.findIndex((f) => f.id === id);
    if (idx === -1) return false;
    this.faqs.splice(idx, 1);
    return true;
  }

  async findActiveFaqs(filter?: { departmentId?: string }): Promise<RagFaq[]> {
    return this.faqs.filter((f) => {
      if (!f.active) return false;
      if (filter?.departmentId) {
        return f.departmentId === filter.departmentId || f.isGlobal;
      }
      return true;
    });
  }

  async getStats() {
    return {
      totalDocuments: this.documents.length,
      totalChunks: this.documents.reduce((acc, d) => acc + d.chunksCount, 0),
      totalVectors: this.documents.reduce((acc, d) => acc + d.chunksCount, 0),
      totalFaqs: this.faqs.length,
      storageSizeBytes: this.documents.reduce((acc, d) => acc + d.sizeBytes, 0),
    };
  }
}

class FakeVectorStore implements VectorStorePort {
  chunks: IndexChunkInput[] = [];

  async indexChunks(chunks: IndexChunkInput[]): Promise<number> {
    this.chunks.push(...chunks);
    return chunks.length;
  }

  async deleteBySource(sourceName: string): Promise<void> {
    this.chunks = this.chunks.filter((c) => c.metadata.source !== sourceName);
  }

  async searchHybrid(input: HybridSearchInput): Promise<RagChunk[]> {
    const filtered = this.chunks.filter((c) => {
      if (input.departmentId) {
        return c.metadata.departmentId === input.departmentId || c.metadata.isGlobal;
      }
      return true;
    });

    return filtered.map((c, i) => ({
      id: `chunk-${i}`,
      sourceName: c.metadata.source,
      contentSnippet: c.text,
      similarityScore: 0.85,
    }));
  }

  async countVectors(): Promise<number> {
    return this.chunks.length;
  }
}

class FakeEmbeddingProvider implements EmbeddingProviderPort {
  async generateEmbedding(_text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3];
  }
  getModelName(): string {
    return "fake-embedding";
  }
  getDimension(): number {
    return 1536;
  }
}

describe("Departmental RAG Knowledge Base", () => {
  it("indexes document with departmentId and searches within department + global scope", async () => {
    const docRepo = new FakeRagDocumentRepository();
    const vectorStore = new FakeVectorStore();
    const embeddingProvider = new FakeEmbeddingProvider();

    const ragService = new RagService({
      documentRepository: docRepo,
      vectorStore,
      embeddingProvider,
    });

    // 1. Index global document
    await ragService.processAndIndexDocument(Buffer.from("Información general de la empresa y horarios"), {
      id: "doc-global-1",
      name: "info_general.txt",
      category: "General",
      departmentId: null,
      isGlobal: true,
      mimeType: "text/plain",
      sizeBytes: 50,
      uploadedBy: "Admin",
    });

    // 2. Index support department document
    await ragService.processAndIndexDocument(Buffer.from("Procedimiento de soporte técnico de routers"), {
      id: "doc-support-1",
      name: "soporte_routers.txt",
      category: "Soporte",
      departmentId: "dep-support-id",
      isGlobal: false,
      mimeType: "text/plain",
      sizeBytes: 50,
      uploadedBy: "Soporte Lead",
    });

    // 3. Index billing department document
    await ragService.processAndIndexDocument(Buffer.from("Políticas de facturación y cobro diferido"), {
      id: "doc-billing-1",
      name: "facturacion.txt",
      category: "Facturación",
      departmentId: "dep-billing-id",
      isGlobal: false,
      mimeType: "text/plain",
      sizeBytes: 50,
      uploadedBy: "Finanzas Lead",
    });

    // Query from Support department should see Support + Global, but NOT Billing
    const supportResults = await ragService.searchHybrid("routers", 4, "dep-support-id");
    const supportSources = supportResults.map((r) => r.sourceName);
    expect(supportSources).toContain("soporte_routers.txt");
    expect(supportSources).toContain("info_general.txt");
    expect(supportSources).not.toContain("facturacion.txt");

    // Query from Billing department should see Billing + Global, but NOT Support
    const billingResults = await ragService.searchHybrid("factura", 4, "dep-billing-id");
    const billingSources = billingResults.map((r) => r.sourceName);
    expect(billingSources).toContain("facturacion.txt");
    expect(billingSources).toContain("info_general.txt");
    expect(billingSources).not.toContain("soporte_routers.txt");
  });

  it("filters FAQs by department and global scope in query fallback", async () => {
    const docRepo = new FakeRagDocumentRepository();
    const vectorStore = new FakeVectorStore();
    const embeddingProvider = new FakeEmbeddingProvider();

    const ragService = new RagService({
      documentRepository: docRepo,
      vectorStore,
      embeddingProvider,
    });

    await docRepo.createFaq({
      id: "faq-1",
      category: "Soporte",
      departmentId: "dep-support-id",
      isGlobal: false,
      question: "¿Cómo reiniciar la ONT?",
      answer: "Desconecte el cable de poder por 10 segundos.",
      tags: ["ont", "reiniciar"],
    });

    await docRepo.createFaq({
      id: "faq-2",
      category: "General",
      departmentId: null,
      isGlobal: true,
      question: "¿Cuáles son las cuentas bancarias de la empresa?",
      answer: "Banco Pichincha cuenta corriente 123456789.",
      tags: ["banco", "pago"],
    });

    const activeFaqs = await docRepo.findActiveFaqs({ departmentId: "dep-support-id" });
    expect(activeFaqs.length).toBe(2);
    expect(activeFaqs.map((f) => f.id)).toEqual(["faq-1", "faq-2"]);

    const billingFaqs = await docRepo.findActiveFaqs({ departmentId: "dep-billing-id" });
    expect(billingFaqs.length).toBe(1);
    expect(billingFaqs[0]?.id).toBe("faq-2"); // Only global FAQ
  });
});
