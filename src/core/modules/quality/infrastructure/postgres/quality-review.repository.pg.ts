import type { Pool } from "pg";
import type { QualityCoachingNote } from "../../domain/quality-coaching-note.entity";
import type { QualityFinding } from "../../domain/quality-finding.entity";
import type {
  QualityReview,
  QualityReviewListItem,
  QualityReviewStatus,
  QualityTriggerKind,
} from "../../domain/quality-review.entity";
import type {
  AddCoachingNoteInput,
  AgentQualityStats,
  CreatePendingQualityReviewInput,
  ListQualityReviewsFilter,
  MarkReadyInput,
  QualityReviewDetail,
  QualityReviewRepositoryPort,
  SaveChunkProgressInput,
} from "../../application/ports/quality-review.repository.port";

type ReviewRow = {
  id: string;
  conversation_id: string;
  case_id: string;
  agent_id: string;
  department_id: string | null;
  cordiality_score: number | null;
  efficiency_notes: string | null;
  summary: string | null;
  error_message: string | null;
  status: QualityReviewStatus;
  trigger_kind: QualityTriggerKind;
  model_raw: unknown | null;
  idempotency_key: string;
  messages_total: number;
  messages_analyzed: number;
  chunk_size: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

type ListRow = ReviewRow & {
  wa_phone: string;
  wa_profile_name: string | null;
  customer_full_name: string | null;
  finding_count: string;
  high_finding_count: string;
};

type FindingRow = {
  id: string;
  review_id: string;
  message_id: string;
  severity: QualityFinding["severity"];
  category: QualityFinding["category"];
  excerpt: string;
  rationale: string;
  created_at: Date;
};

type NoteRow = {
  id: string;
  review_id: string;
  author_agent_id: string;
  body: string;
  ack_status: QualityCoachingNote["ackStatus"];
  acknowledged_at: Date | null;
  created_at: Date;
};

function mapReview(row: ReviewRow): QualityReview {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    caseId: row.case_id,
    agentId: row.agent_id,
    departmentId: row.department_id,
    cordialityScore: row.cordiality_score,
    efficiencyNotes: row.efficiency_notes,
    summary: row.summary,
    errorMessage: row.error_message,
    status: row.status,
    triggerKind: row.trigger_kind,
    modelRaw: row.model_raw,
    idempotencyKey: row.idempotency_key,
    messagesTotal: Number(row.messages_total ?? 0),
    messagesAnalyzed: Number(row.messages_analyzed ?? 0),
    chunkSize: Number(row.chunk_size ?? 40),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function customerLabelFrom(
  fullName: string | null,
  profileName: string | null,
  waPhone: string,
): string {
  const name = fullName?.trim() || profileName?.trim();
  return name && name.length > 0 ? name : waPhone;
}

function mapListItem(row: ListRow): QualityReviewListItem {
  return {
    ...mapReview(row),
    customerLabel: customerLabelFrom(row.customer_full_name, row.wa_profile_name, row.wa_phone),
    waPhone: row.wa_phone,
    waProfileName: row.wa_profile_name,
    highFindingCount: Number(row.high_finding_count),
    findingCount: Number(row.finding_count),
  };
}

function mapFinding(row: FindingRow): QualityFinding {
  return {
    id: row.id,
    reviewId: row.review_id,
    messageId: row.message_id,
    severity: row.severity,
    category: row.category,
    excerpt: row.excerpt,
    rationale: row.rationale,
    createdAt: row.created_at,
  };
}

function mapNote(row: NoteRow): QualityCoachingNote {
  return {
    id: row.id,
    reviewId: row.review_id,
    authorAgentId: row.author_agent_id,
    body: row.body,
    ackStatus: row.ack_status,
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
  };
}

export class QualityReviewRepositoryPg implements QualityReviewRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async createPending(input: CreatePendingQualityReviewInput): Promise<QualityReview> {
    const chunkSize = input.chunkSize ?? 40;
    const inserted = await this.pool.query<ReviewRow>(
      `INSERT INTO quality_review (
         conversation_id, case_id, agent_id, department_id, trigger_kind, idempotency_key,
         status, chunk_size, messages_total, messages_analyzed
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, 0, 0)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.conversationId,
        input.caseId,
        input.agentId,
        input.departmentId,
        input.triggerKind,
        input.idempotencyKey,
        chunkSize,
      ],
    );
    if (inserted.rows[0]) return mapReview(inserted.rows[0]);

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (!existing) {
      throw new Error(`quality_review no encontrada tras conflicto: ${input.idempotencyKey}`);
    }
    return existing;
  }

  async findByIdempotencyKey(key: string): Promise<QualityReview | null> {
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT * FROM quality_review WHERE idempotency_key = $1`,
      [key],
    );
    return rows[0] ? mapReview(rows[0]) : null;
  }

  async findById(id: string): Promise<QualityReviewDetail | null> {
    const { rows } = await this.pool.query<
      ReviewRow & {
        wa_phone: string | null;
        wa_profile_name: string | null;
        customer_full_name: string | null;
      }
    >(
      `SELECT qr.*,
              conv.wa_phone,
              conv.wa_profile_name,
              cust.full_name AS customer_full_name
       FROM quality_review qr
       LEFT JOIN conversation conv ON conv.id = qr.conversation_id
       LEFT JOIN customer cust ON cust.id = conv.customer_id
       WHERE qr.id = $1`,
      [id],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const waPhone = row.wa_phone ?? "";
    const [findings, notes] = await Promise.all([this.listFindings(id), this.listNotes(id)]);
    return {
      review: mapReview(row),
      findings,
      notes,
      customerLabel: customerLabelFrom(row.customer_full_name, row.wa_profile_name, waPhone),
      waPhone,
      waProfileName: row.wa_profile_name,
    };
  }

  async findPendingByCaseAndAgent(caseId: string, agentId: string): Promise<QualityReview | null> {
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT * FROM quality_review
       WHERE case_id = $1 AND agent_id = $2 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [caseId, agentId],
    );
    return rows[0] ? mapReview(rows[0]) : null;
  }

  async findLatestByCaseAndAgent(caseId: string, agentId: string): Promise<QualityReview | null> {
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT * FROM quality_review
       WHERE case_id = $1 AND agent_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [caseId, agentId],
    );
    return rows[0] ? mapReview(rows[0]) : null;
  }

  async listReviews(filters: ListQualityReviewsFilter): Promise<QualityReviewListItem[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.agentId) {
      params.push(filters.agentId);
      clauses.push(`qr.agent_id = $${params.length}`);
    }
    if (filters.from) {
      params.push(filters.from);
      clauses.push(`qr.created_at >= $${params.length}`);
    }
    if (filters.to) {
      params.push(filters.to);
      clauses.push(`qr.created_at <= $${params.length}`);
    }
    if (filters.minScore !== undefined) {
      params.push(filters.minScore);
      clauses.push(`qr.cordiality_score >= $${params.length}`);
    }
    if (filters.maxScore !== undefined) {
      params.push(filters.maxScore);
      clauses.push(`qr.cordiality_score <= $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      clauses.push(`qr.status = $${params.length}`);
    }
    if (filters.departmentIds !== null && filters.departmentIds !== undefined) {
      if (filters.departmentIds.length === 0) return [];
      params.push(filters.departmentIds);
      clauses.push(`qr.department_id = ANY($${params.length}::uuid[])`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    // Una fila por caso+agente (la review más reciente) — evita duplicados por reintentos.
    const { rows } = await this.pool.query<ListRow>(
      `SELECT DISTINCT ON (qr.case_id, qr.agent_id)
              qr.*,
              conv.wa_phone,
              conv.wa_profile_name,
              cust.full_name AS customer_full_name,
              COALESCE(fc.finding_count, 0)::text AS finding_count,
              COALESCE(fc.high_finding_count, 0)::text AS high_finding_count
       FROM quality_review qr
       LEFT JOIN conversation conv ON conv.id = qr.conversation_id
       LEFT JOIN customer cust ON cust.id = conv.customer_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS finding_count,
                COUNT(*) FILTER (WHERE qf.severity = 'high')::int AS high_finding_count
         FROM quality_finding qf
         WHERE qf.review_id = qr.id
       ) fc ON true
       ${where}
       ORDER BY qr.case_id, qr.agent_id, qr.created_at DESC`,
      params,
    );
    // Reordenar por fecha reciente para la UI.
    const items = rows.map((r) =>
      mapListItem({
        ...r,
        wa_phone: r.wa_phone ?? "",
      }),
    );
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return items;
  }

  async claimNextPending(): Promise<QualityReview | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<ReviewRow>(
        `SELECT id FROM quality_review
         WHERE status = 'pending' AND started_at IS NULL
         ORDER BY created_at DESC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      if (!rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const updated = await client.query<ReviewRow>(
        `UPDATE quality_review
         SET started_at = now(), error_message = NULL
         WHERE id = $1
         RETURNING *`,
        [rows[0].id],
      );
      await client.query("COMMIT");
      return updated.rows[0] ? mapReview(updated.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listStuckStartedPending(staleStartedBefore: Date): Promise<QualityReview[]> {
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT * FROM quality_review
       WHERE status = 'pending'
         AND started_at IS NOT NULL
         AND started_at < $1
       ORDER BY created_at ASC`,
      [staleStartedBefore],
    );
    return rows.map(mapReview);
  }

  async resetAllPendingClaims(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE quality_review
       SET started_at = NULL
       WHERE status = 'pending' AND started_at IS NOT NULL`,
    );
    return rowCount ?? 0;
  }

  async markReady(reviewId: string, input: MarkReadyInput): Promise<QualityReviewDetail> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<ReviewRow>(
        `UPDATE quality_review
         SET status = 'ready',
             cordiality_score = $2,
             efficiency_notes = $3,
             summary = $4,
             error_message = NULL,
             model_raw = $5::jsonb,
             messages_total = $6,
             messages_analyzed = $7,
             chunk_size = $8,
             started_at = NULL,
             completed_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          reviewId,
          input.cordialityScore,
          input.efficiencyNotes,
          input.summary,
          JSON.stringify(input.modelRaw),
          input.messagesTotal,
          input.messagesAnalyzed,
          input.chunkSize,
        ],
      );
      if (!updated.rows[0]) {
        throw new Error(`quality_review ${reviewId} no encontrada`);
      }

      await client.query(`DELETE FROM quality_finding WHERE review_id = $1`, [reviewId]);
      for (const f of input.findings) {
        await client.query(
          `INSERT INTO quality_finding (review_id, message_id, severity, category, excerpt, rationale)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [reviewId, f.messageId, f.severity, f.category, f.excerpt, f.rationale],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const detail = await this.findById(reviewId);
    if (!detail) throw new Error(`quality_review ${reviewId} no encontrada tras markReady`);
    return detail;
  }

  async saveChunkProgress(
    reviewId: string,
    input: SaveChunkProgressInput,
  ): Promise<QualityReviewDetail> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<ReviewRow>(
        `UPDATE quality_review
         SET status = 'pending',
             cordiality_score = $2,
             efficiency_notes = $3,
             summary = $4,
             error_message = NULL,
             model_raw = $5::jsonb,
             messages_total = $6,
             messages_analyzed = $7,
             chunk_size = $8,
             started_at = NULL,
             completed_at = NULL
         WHERE id = $1
         RETURNING *`,
        [
          reviewId,
          input.provisionalScore,
          input.efficiencyNotes,
          input.summary,
          JSON.stringify(input.modelRaw),
          input.messagesTotal,
          input.messagesAnalyzed,
          input.chunkSize,
        ],
      );
      if (!updated.rows[0]) {
        throw new Error(`quality_review ${reviewId} no encontrada`);
      }

      await client.query(`DELETE FROM quality_finding WHERE review_id = $1`, [reviewId]);
      for (const f of input.findings) {
        await client.query(
          `INSERT INTO quality_finding (review_id, message_id, severity, category, excerpt, rationale)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [reviewId, f.messageId, f.severity, f.category, f.excerpt, f.rationale],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const detail = await this.findById(reviewId);
    if (!detail) throw new Error(`quality_review ${reviewId} no encontrada tras saveChunkProgress`);
    return detail;
  }

  async markFailed(reviewId: string, errorMessage?: string): Promise<void> {
    await this.pool.query(
      `UPDATE quality_review
       SET status = 'failed',
           error_message = $2,
           started_at = NULL,
           completed_at = now()
       WHERE id = $1`,
      [reviewId, errorMessage ?? null],
    );
  }

  async reopenFailedAsPending(reviewId: string): Promise<QualityReview> {
    const { rows } = await this.pool.query<ReviewRow>(
      `UPDATE quality_review
       SET status = 'pending',
           error_message = NULL,
           started_at = NULL,
           completed_at = NULL
       WHERE id = $1 AND status = 'failed'
       RETURNING *`,
      [reviewId],
    );
    if (!rows[0]) throw new Error(`quality_review ${reviewId} no es failed o no existe`);
    return mapReview(rows[0]);
  }

  async markReviewed(reviewId: string): Promise<QualityReview> {
    const { rows } = await this.pool.query<ReviewRow>(
      `UPDATE quality_review SET status = 'reviewed' WHERE id = $1 RETURNING *`,
      [reviewId],
    );
    if (!rows[0]) throw new Error(`quality_review ${reviewId} no encontrada`);
    return mapReview(rows[0]);
  }

  async addCoachingNote(input: AddCoachingNoteInput): Promise<QualityCoachingNote> {
    const { rows } = await this.pool.query<NoteRow>(
      `INSERT INTO quality_coaching_note (review_id, author_agent_id, body)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.reviewId, input.authorAgentId, input.body],
    );
    return mapNote(rows[0]!);
  }

  async getAgentStats(
    from: Date,
    to: Date,
    departmentIds?: string[] | null,
  ): Promise<AgentQualityStats[]> {
    if (departmentIds !== null && departmentIds !== undefined && departmentIds.length === 0) {
      return [];
    }

    const scoped = departmentIds === null || departmentIds === undefined ? null : departmentIds;
    const deptCaseFilter = scoped ? ` AND c.department_id = ANY($3::uuid[])` : "";

    const { rows } = await this.pool.query<{
      agent_id: string;
      agent_name: string;
      cases_completed: string;
      closed_with_agent: string;
      analyzed_count: string;
      pending_count: string;
      failed_count: string;
      avg_cordiality: string | null;
      critical_count: string;
      avg_first_reply_ms: string | null;
    }>(
      `WITH completed_cases AS (
         SELECT c.id, c.conversation_id, c.assigned_agent_id, c.department_id, c.updated_at
         FROM "case" c
         WHERE c.status = 'COMPLETED'
           AND c.assigned_agent_id IS NOT NULL
           AND c.updated_at >= $1 AND c.updated_at <= $2
           ${deptCaseFilter}
       ),
       closed_with_agent AS (
         SELECT c.assigned_agent_id AS agent_id, COUNT(*)::int AS n
         FROM "case" c
         WHERE c.status IN ('COMPLETED', 'EXPIRED', 'CANCELLED')
           AND c.assigned_agent_id IS NOT NULL
           AND c.updated_at >= $1 AND c.updated_at <= $2
           ${deptCaseFilter}
           AND EXISTS (
             SELECT 1 FROM message m
             WHERE (m.case_id = c.id OR (m.conversation_id = c.conversation_id AND m.agent_id = c.assigned_agent_id))
               AND m.author = 'agent'
           )
         GROUP BY c.assigned_agent_id
       ),
       review_status AS (
         SELECT qr.agent_id,
                COUNT(*) FILTER (WHERE qr.status IN ('ready', 'reviewed'))::int AS analyzed_count,
                COUNT(*) FILTER (WHERE qr.status = 'pending')::int AS pending_count,
                COUNT(*) FILTER (WHERE qr.status = 'failed')::int AS failed_count,
                AVG(qr.cordiality_score) FILTER (WHERE qr.status IN ('ready', 'reviewed'))::float AS avg_score,
                COUNT(*) FILTER (
                  WHERE qr.status IN ('ready', 'reviewed') AND qr.cordiality_score < 40
                )::int AS critical_count
         FROM quality_review qr
         WHERE qr.created_at >= $1 AND qr.created_at <= $2
           AND ($3::uuid[] IS NULL OR qr.department_id = ANY($3::uuid[]))
         GROUP BY qr.agent_id
       ),
       first_reply AS (
         SELECT cc.id AS case_id,
                cc.assigned_agent_id,
                EXTRACT(EPOCH FROM (
                  (SELECT MIN(m.created_at) FROM message m
                   WHERE (m.case_id = cc.id OR (m.conversation_id = cc.conversation_id AND m.agent_id = cc.assigned_agent_id))
                     AND m.author = 'agent')
                  -
                  COALESCE(
                    (SELECT MIN(we.occurred_at) FROM workflow_event we
                     WHERE we.case_id = cc.id
                       AND we.type IN ('CASE_ESCALATED', 'HUMAN_ACTIVE', 'CASE_CLAIMED', 'CASE_ASSIGNED')),
                    cc.updated_at
                  )
                )) * 1000 AS reply_ms
         FROM completed_cases cc
       )
       SELECT a.id AS agent_id,
              a.name AS agent_name,
              COUNT(DISTINCT cc.id)::text AS cases_completed,
              COALESCE(cwa.n, 0)::text AS closed_with_agent,
              COALESCE(rs.analyzed_count, 0)::text AS analyzed_count,
              COALESCE(rs.pending_count, 0)::text AS pending_count,
              COALESCE(rs.failed_count, 0)::text AS failed_count,
              rs.avg_score::text AS avg_cordiality,
              COALESCE(rs.critical_count, 0)::text AS critical_count,
              AVG(fr.reply_ms) FILTER (WHERE fr.reply_ms IS NOT NULL AND fr.reply_ms >= 0)::text AS avg_first_reply_ms
       FROM agent a
       LEFT JOIN completed_cases cc ON cc.assigned_agent_id = a.id
       LEFT JOIN closed_with_agent cwa ON cwa.agent_id = a.id
       LEFT JOIN review_status rs ON rs.agent_id = a.id
       LEFT JOIN first_reply fr ON fr.assigned_agent_id = a.id
       WHERE a.active = true
       GROUP BY a.id, a.name, cwa.n, rs.analyzed_count, rs.pending_count, rs.failed_count,
                rs.avg_score, rs.critical_count
       ORDER BY a.name ASC`,
      [from, to, scoped],
    );

    return rows.map((r) => {
      const analyzedCount = Number(r.analyzed_count);
      return {
        agentId: r.agent_id,
        agentName: r.agent_name,
        casesCompleted: Number(r.cases_completed),
        closedWithAgentMessages: Number(r.closed_with_agent),
        analyzedCount,
        pendingCount: Number(r.pending_count),
        failedCount: Number(r.failed_count),
        avgCordialityScore:
          analyzedCount === 0 || r.avg_cordiality === null ? null : Number(r.avg_cordiality),
        criticalReviewCount: Number(r.critical_count),
        avgFirstHumanReplyMs: r.avg_first_reply_ms === null ? null : Number(r.avg_first_reply_ms),
      };
    });
  }

  async listEligibleCasesForAnalysis(filters: {
    from: Date;
    to: Date;
    agentId?: string;
    departmentIds?: string[] | null;
    limit: number;
  }): Promise<
    Array<{
      caseId: string;
      conversationId: string;
      agentId: string;
      departmentId: string | null;
    }>
  > {
    const scoped = filters.departmentIds === undefined ? null : filters.departmentIds;
    const { rows } = await this.pool.query<{
      id: string;
      conversation_id: string;
      assigned_agent_id: string;
      department_id: string | null;
    }>(
      `SELECT c.id, c.conversation_id, c.assigned_agent_id, c.department_id
       FROM "case" c
       WHERE c.status IN ('COMPLETED', 'EXPIRED', 'CANCELLED')
         AND c.assigned_agent_id IS NOT NULL
         AND c.updated_at >= $1 AND c.updated_at <= $2
         AND ($3::uuid IS NULL OR c.assigned_agent_id = $3::uuid)
         AND ($4::uuid[] IS NULL OR c.department_id = ANY($4::uuid[]))
         AND EXISTS (
           SELECT 1 FROM message m
           WHERE (m.case_id = c.id OR (m.conversation_id = c.conversation_id AND m.agent_id = c.assigned_agent_id))
             AND m.author = 'agent'
         )
         AND NOT EXISTS (
           SELECT 1 FROM quality_review qr
           WHERE qr.case_id = c.id
             AND qr.agent_id = c.assigned_agent_id
             AND qr.status IN ('pending', 'ready', 'reviewed')
         )
       ORDER BY c.updated_at DESC
       LIMIT $5`,
      [filters.from, filters.to, filters.agentId ?? null, scoped, filters.limit],
    );
    return rows.map((r) => ({
      caseId: r.id,
      conversationId: r.conversation_id,
      agentId: r.assigned_agent_id,
      departmentId: r.department_id,
    }));
  }

  async countByStatus(
    status: QualityReviewStatus,
    filters?: { agentId?: string; departmentIds?: string[] | null },
  ): Promise<number> {
    const scoped =
      filters?.departmentIds === undefined ? null : (filters.departmentIds ?? null);
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM quality_review
       WHERE status = $1
         AND ($2::uuid IS NULL OR agent_id = $2::uuid)
         AND ($3::uuid[] IS NULL OR department_id = ANY($3::uuid[]))`,
      [status, filters?.agentId ?? null, scoped],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async listFindings(reviewId: string): Promise<QualityFinding[]> {
    const { rows } = await this.pool.query<FindingRow>(
      `SELECT * FROM quality_finding WHERE review_id = $1 ORDER BY created_at ASC`,
      [reviewId],
    );
    return rows.map(mapFinding);
  }

  private async listNotes(reviewId: string): Promise<QualityCoachingNote[]> {
    const { rows } = await this.pool.query<NoteRow>(
      `SELECT * FROM quality_coaching_note WHERE review_id = $1 ORDER BY created_at ASC`,
      [reviewId],
    );
    return rows.map(mapNote);
  }
}
