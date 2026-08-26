import type { Pool } from "pg";
import type { RagChunk } from "../../domain/rag.entity";
import type {
  HybridSearchInput,
  IndexChunkInput,
  VectorStorePort,
} from "../../application/ports/vector-store.port";

export class PgVectorStoreAdapter implements VectorStorePort {
  constructor(private readonly pool: Pool) {}

  async indexChunks(chunks: IndexChunkInput[]): Promise<number> {
    if (chunks.length === 0) return 0;

    let count = 0;
    for (const chunk of chunks) {
      const vectorStr = `[${chunk.embedding.join(",")}]`;
      await this.pool.query(
        `INSERT INTO n8n_vectors (text, metadata, embedding) VALUES ($1, $2::jsonb, $3::vector)`,
        [chunk.text, JSON.stringify(chunk.metadata), vectorStr]
      );
      count++;
    }
    return count;
  }

  async deleteBySource(sourceName: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM n8n_vectors WHERE metadata->>'source' = $1 OR metadata->>'filename' = $1`,
      [sourceName]
    );
  }

  async searchHybrid(input: HybridSearchInput): Promise<RagChunk[]> {
    const vectorStr = `[${input.embedding.join(",")}]`;
    const params: any[] = [vectorStr];

    let keywordSql = "0.0";
    if (input.keywords.length > 0) {
      const conditions = input.keywords.map((k) => {
        params.push(`%${k}%`);
        return `CASE WHEN text ILIKE $${params.length} THEN 0.15 ELSE 0.0 END`;
      });
      keywordSql = conditions.join(" + ");
    }

    const query = `
      WITH matches AS (
        SELECT id, text, metadata,
               (1 - (embedding <=> $1::vector)) AS vec_score,
               (${keywordSql}) AS keyword_boost
        FROM n8n_vectors
        WHERE length(text) > 30
      )
      SELECT id, text, metadata, vec_score, (vec_score + keyword_boost) AS total_score
      FROM matches
      ORDER BY total_score DESC
      LIMIT ${input.limit};
    `;

    const { rows } = await this.pool.query(query, params);

    return rows.map((row) => ({
      id: row.id,
      sourceName: (row.metadata as any)?.filename || (row.metadata as any)?.source || "Base de Conocimiento",
      contentSnippet: row.text,
      similarityScore: Math.min(1, Math.max(0, Number(row.total_score || row.vec_score || 0.5))),
      section: (row.metadata as any)?.section,
    }));
  }

  async countVectors(): Promise<number> {
    const { rows } = await this.pool.query("SELECT count(*) as total FROM n8n_vectors");
    return Number(rows[0]?.total || 0);
  }
}
