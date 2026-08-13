import type { QualityCoachingNote } from "../../domain/quality-coaching-note.entity";
import type { QualityFinding, QualityFindingCategory, QualityFindingSeverity } from "../../domain/quality-finding.entity";
import type {
  QualityReview,
  QualityReviewListItem,
  QualityReviewStatus,
  QualityTriggerKind,
} from "../../domain/quality-review.entity";

export type CreatePendingQualityReviewInput = {
  conversationId: string;
  caseId: string;
  agentId: string;
  departmentId: string | null;
  triggerKind: QualityTriggerKind;
  idempotencyKey: string;
  /** Tamaño de tramo; default 40 si se omite. */
  chunkSize?: number;
};

export type MarkReadyInput = {
  cordialityScore: number;
  efficiencyNotes: string | null;
  summary: string;
  modelRaw: unknown;
  findings: Array<{
    messageId: string;
    severity: QualityFindingSeverity;
    category: QualityFindingCategory;
    excerpt: string;
    rationale: string;
  }>;
  messagesTotal: number;
  messagesAnalyzed: number;
  chunkSize: number;
};

/** Progreso parcial: sigue pending; libera claim para el siguiente tramo. */
export type SaveChunkProgressInput = {
  messagesTotal: number;
  messagesAnalyzed: number;
  chunkSize: number;
  provisionalScore: number;
  efficiencyNotes: string | null;
  summary: string;
  modelRaw: unknown;
  findings: Array<{
    messageId: string;
    severity: QualityFindingSeverity;
    category: QualityFindingCategory;
    excerpt: string;
    rationale: string;
  }>;
};

export type ListQualityReviewsFilter = {
  agentId?: string;
  from?: Date;
  to?: Date;
  minScore?: number;
  maxScore?: number;
  status?: QualityReviewStatus;
  /** null = sin filtro de depto (admin); array = restringir a esos deptos (manager). */
  departmentIds?: string[] | null;
};

export type QualityReviewDetail = {
  review: QualityReview;
  findings: QualityFinding[];
  notes: QualityCoachingNote[];
  customerLabel: string;
  waPhone: string;
  waProfileName: string | null;
};

export type AgentQualityStats = {
  agentId: string;
  agentName: string;
  casesCompleted: number;
  /** Casos cerrados con mensajes agent en el rango (elegibles / cobertura). */
  closedWithAgentMessages: number;
  /** Reviews ready+reviewed en el rango. */
  analyzedCount: number;
  pendingCount: number;
  failedCount: number;
  avgCordialityScore: number | null;
  criticalReviewCount: number;
  avgFirstHumanReplyMs: number | null;
};

/** Caso cerrado elegible para encolar análisis (sin review pending/ready/reviewed). */
export type EligibleCaseForAnalysis = {
  caseId: string;
  conversationId: string;
  agentId: string;
  departmentId: string | null;
};

export type ListEligibleCasesFilter = {
  from: Date;
  to: Date;
  agentId?: string;
  departmentIds?: string[] | null;
  limit: number;
};

export type AddCoachingNoteInput = {
  reviewId: string;
  authorAgentId: string;
  body: string;
};

export interface QualityReviewRepositoryPort {
  /**
   * Crea pending; si `idempotency_key` ya existe, devuelve la review existente
   * (07_QUALITY_SUPERVISION.md §4.1).
   */
  createPending(input: CreatePendingQualityReviewInput): Promise<QualityReview>;
  findByIdempotencyKey(key: string): Promise<QualityReview | null>;
  findById(id: string): Promise<QualityReviewDetail | null>;
  findPendingByCaseAndAgent(caseId: string, agentId: string): Promise<QualityReview | null>;
  /** Ultima review del caso+agente (cualquier status). */
  findLatestByCaseAndAgent(caseId: string, agentId: string): Promise<QualityReview | null>;
  listReviews(filters: ListQualityReviewsFilter): Promise<QualityReviewListItem[]>;
  /** Casos COMPLETED/EXPIRED/CANCELLED con mensajes agent y sin review útil. */
  listEligibleCasesForAnalysis(filters: ListEligibleCasesFilter): Promise<EligibleCaseForAnalysis[]>;
  countByStatus(
    status: QualityReviewStatus,
    filters?: { agentId?: string; departmentIds?: string[] | null },
  ): Promise<number>;
  /** Claim atomico del siguiente pending (SKIP LOCKED). null si no hay. */
  claimNextPending(): Promise<QualityReview | null>;
  /** Pending con started_at anterior a la fecha (jobs atascados). */
  listStuckStartedPending(staleStartedBefore: Date): Promise<QualityReview[]>;
  /** Tras reinicio: limpia started_at de todos los pending en vuelo. */
  resetAllPendingClaims(): Promise<number>;
  markReady(reviewId: string, input: MarkReadyInput): Promise<QualityReviewDetail>;
  /** Persiste tramo parcial; status=pending y started_at=NULL para re-claim. */
  saveChunkProgress(reviewId: string, input: SaveChunkProgressInput): Promise<QualityReviewDetail>;
  markFailed(reviewId: string, errorMessage?: string): Promise<void>;
  /** Reabre failed → pending para reintento manual (mismo registro). */
  reopenFailedAsPending(reviewId: string): Promise<QualityReview>;
  markReviewed(reviewId: string): Promise<QualityReview>;
  addCoachingNote(input: AddCoachingNoteInput): Promise<QualityCoachingNote>;
  getAgentStats(
    from: Date,
    to: Date,
    departmentIds?: string[] | null,
  ): Promise<AgentQualityStats[]>;
}
