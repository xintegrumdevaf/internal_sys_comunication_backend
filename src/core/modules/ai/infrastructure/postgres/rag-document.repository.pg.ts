import type { Pool } from "pg";
import type { RagDocument, RagFaq, RagStats } from "../../domain/rag.entity";
import type {
  CreateRagDocumentInput,
  CreateRagFaqInput,
  RagDocumentRepositoryPort,
  UpdateRagFaqInput,
} from "../../application/ports/rag-document.repository.port";

export class RagDocumentRepositoryPg implements RagDocumentRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async listDocuments(): Promise<RagDocument[]> {
    const { rows } = await this.pool.query(
      `SELECT 
        id, 
        name, 
        category, 
        mime_type AS "mimeType", 
        size_bytes AS "sizeBytes", 
        status, 
        chunks_count AS "chunksCount", 
        uploaded_by AS "uploadedBy", 
        source_url AS "sourceUrl", 
        error_message AS "errorMessage", 
        created_at AS "createdAt", 
        updated_at AS "updatedAt"
      FROM rag_documents 
      ORDER BY created_at DESC`
    );
    return rows;
  }

  async createDocument(input: CreateRagDocumentInput): Promise<RagDocument> {
    const { rows } = await this.pool.query(
      `INSERT INTO rag_documents 
        (id, name, category, mime_type, size_bytes, status, chunks_count, uploaded_by, source_url)
      VALUES 
        ($1, $2, $3, $4, $5, 'processed', $6, $7, $8)
      RETURNING 
        id, 
        name, 
        category, 
        mime_type AS "mimeType", 
        size_bytes AS "sizeBytes", 
        status, 
        chunks_count AS "chunksCount", 
        uploaded_by AS "uploadedBy", 
        source_url AS "sourceUrl", 
        created_at AS "createdAt"`,
      [
        input.id,
        input.name,
        input.category,
        input.mimeType,
        input.sizeBytes,
        input.chunksCount,
        input.uploadedBy,
        input.sourceUrl || null,
      ]
    );
    return rows[0];
  }

  async findDocumentById(id: string): Promise<RagDocument | null> {
    const { rows } = await this.pool.query(
      `SELECT 
        id, 
        name, 
        category, 
        mime_type AS "mimeType", 
        size_bytes AS "sizeBytes", 
        status, 
        chunks_count AS "chunksCount", 
        uploaded_by AS "uploadedBy", 
        source_url AS "sourceUrl", 
        error_message AS "errorMessage", 
        created_at AS "createdAt", 
        updated_at AS "updatedAt"
      FROM rag_documents 
      WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  async deleteDocument(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM rag_documents WHERE id = $1`, [id]);
    return Boolean(rowCount && rowCount > 0);
  }

  async listFaqs(): Promise<RagFaq[]> {
    const { rows } = await this.pool.query(`SELECT * FROM rag_faqs ORDER BY category, priority DESC`);
    return rows;
  }

  async createFaq(input: CreateRagFaqInput): Promise<RagFaq> {
    const { rows } = await this.pool.query(
      `INSERT INTO rag_faqs (id, category, question, answer, tags, variations, priority, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [
        input.id,
        input.category,
        input.question,
        input.answer,
        input.tags || [],
        input.variations || [],
        input.priority || 5,
      ]
    );
    return rows[0];
  }

  async updateFaq(id: string, input: UpdateRagFaqInput): Promise<RagFaq | null> {
    const { rows } = await this.pool.query(
      `UPDATE rag_faqs
       SET category = COALESCE($1, category),
           question = COALESCE($2, question),
           answer = COALESCE($3, answer),
           tags = COALESCE($4, tags),
           variations = COALESCE($5, variations),
           priority = COALESCE($6, priority),
           active = COALESCE($7, active),
           updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        input.category,
        input.question,
        input.answer,
        input.tags,
        input.variations,
        input.priority,
        input.active,
        id,
      ]
    );
    return rows[0] || null;
  }

  async deleteFaq(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM rag_faqs WHERE id = $1`, [id]);
    return Boolean(rowCount && rowCount > 0);
  }

  async findActiveFaqs(): Promise<RagFaq[]> {
    const { rows } = await this.pool.query(`SELECT * FROM rag_faqs WHERE active = true`);
    return rows;
  }

  async getStats(): Promise<RagStats> {
    const docsRes = await this.pool.query("SELECT count(*) as total_docs FROM rag_documents");
    const vectorsRes = await this.pool.query("SELECT count(*) as total_vectors FROM n8n_vectors");
    const faqsRes = await this.pool.query("SELECT count(*) as total_faqs FROM rag_faqs WHERE active = true");

    return {
      totalDocuments: Number(docsRes.rows[0]?.total_docs || 0),
      totalVectors: Number(vectorsRes.rows[0]?.total_vectors || 0),
      totalFaqs: Number(faqsRes.rows[0]?.total_faqs || 0),
    };
  }
}
