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

  async listDocuments(filter?: { departmentId?: string }): Promise<RagDocument[]> {
    let query = `
      SELECT 
        id, 
        name, 
        category, 
        department_id AS "departmentId",
        is_global AS "isGlobal",
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
    `;
    const params: unknown[] = [];

    if (filter?.departmentId) {
      query += ` WHERE department_id = $1 OR is_global = true `;
      params.push(filter.departmentId);
    }

    query += ` ORDER BY created_at DESC`;

    const { rows } = await this.pool.query(query, params);
    return rows;
  }

  async createDocument(input: CreateRagDocumentInput): Promise<RagDocument> {
    const isGlobal = input.isGlobal ?? (input.departmentId ? false : true);
    const { rows } = await this.pool.query(
      `INSERT INTO rag_documents 
        (id, name, category, department_id, is_global, mime_type, size_bytes, status, chunks_count, uploaded_by, source_url)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7, 'processed', $8, $9, $10)
      RETURNING 
        id, 
        name, 
        category, 
        department_id AS "departmentId",
        is_global AS "isGlobal",
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
        input.departmentId || null,
        isGlobal,
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
        department_id AS "departmentId",
        is_global AS "isGlobal",
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

  async listFaqs(filter?: { departmentId?: string }): Promise<RagFaq[]> {
    let query = `
      SELECT 
        id, category, department_id AS "departmentId", is_global AS "isGlobal",
        question, answer, tags, variations, priority, active, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM rag_faqs
    `;
    const params: unknown[] = [];

    if (filter?.departmentId) {
      query += ` WHERE department_id = $1 OR is_global = true `;
      params.push(filter.departmentId);
    }

    query += ` ORDER BY category, priority DESC`;

    const { rows } = await this.pool.query(query, params);
    return rows;
  }

  async createFaq(input: CreateRagFaqInput): Promise<RagFaq> {
    const isGlobal = input.isGlobal ?? (input.departmentId ? false : true);
    const { rows } = await this.pool.query(
      `INSERT INTO rag_faqs (id, category, department_id, is_global, question, answer, tags, variations, priority, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       RETURNING 
        id, category, department_id AS "departmentId", is_global AS "isGlobal",
        question, answer, tags, variations, priority, active, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        input.id,
        input.category,
        input.departmentId || null,
        isGlobal,
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
           department_id = COALESCE($2, department_id),
           is_global = COALESCE($3, is_global),
           question = COALESCE($4, question),
           answer = COALESCE($5, answer),
           tags = COALESCE($6, tags),
           variations = COALESCE($7, variations),
           priority = COALESCE($8, priority),
           active = COALESCE($9, active),
           updated_at = NOW()
       WHERE id = $10
       RETURNING 
        id, category, department_id AS "departmentId", is_global AS "isGlobal",
        question, answer, tags, variations, priority, active, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        input.category,
        input.departmentId,
        input.isGlobal,
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

  async findActiveFaqs(filter?: { departmentId?: string }): Promise<RagFaq[]> {
    let query = `
      SELECT 
        id, category, department_id AS "departmentId", is_global AS "isGlobal",
        question, answer, tags, variations, priority, active, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM rag_faqs WHERE active = true
    `;
    const params: unknown[] = [];

    if (filter?.departmentId) {
      query += ` AND (department_id = $1 OR is_global = true) `;
      params.push(filter.departmentId);
    }

    const { rows } = await this.pool.query(query, params);
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
