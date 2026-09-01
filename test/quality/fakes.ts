import { randomUUID } from "node:crypto";
import type {
  AddCoachingNoteInput,
  AgentQualityStats,
  CreatePendingQualityReviewInput,
  ListQualityReviewsFilter,
  MarkReadyInput,
  QualityReviewDetail,
  QualityReviewRepositoryPort,
  SaveChunkProgressInput,
} from "../../src/core/modules/quality/application/ports/quality-review.repository.port";
import type { QualityCoachingNote } from "../../src/core/modules/quality/domain/quality-coaching-note.entity";
import type { QualityFinding } from "../../src/core/modules/quality/domain/quality-finding.entity";
import type { QualityReview } from "../../src/core/modules/quality/domain/quality-review.entity";

export class QualityReviewRepositoryFake implements QualityReviewRepositoryPort {
  readonly reviews = new Map<string, QualityReview>();
  readonly findings = new Map<string, QualityFinding[]>();
  readonly notes = new Map<string, QualityCoachingNote[]>();

  async createPending(input: CreatePendingQualityReviewInput): Promise<QualityReview> {
    const existing = [...this.reviews.values()].find((r) => r.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const review: QualityReview = {
      id: randomUUID(),
      conversationId: input.conversationId,
      caseId: input.caseId,
      agentId: input.agentId,
      departmentId: input.departmentId,
      cordialityScore: null,
      efficiencyNotes: null,
      summary: null,
      errorMessage: null,
      status: "pending",
      triggerKind: input.triggerKind,
      modelRaw: null,
      idempotencyKey: input.idempotencyKey,
      messagesTotal: 0,
      messagesAnalyzed: 0,
      chunkSize: input.chunkSize ?? 40,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };
    this.reviews.set(review.id, review);
    this.findings.set(review.id, []);
    this.notes.set(review.id, []);
    return review;
  }

  async findByIdempotencyKey(key: string): Promise<QualityReview | null> {
    return [...this.reviews.values()].find((r) => r.idempotencyKey === key) ?? null;
  }

  async findById(id: string): Promise<QualityReviewDetail | null> {
    const review = this.reviews.get(id);
    if (!review) return null;
    return {
      review,
      findings: this.findings.get(id) ?? [],
      notes: this.notes.get(id) ?? [],
      customerLabel: "Cliente test",
      waPhone: "+5939900000",
      waProfileName: null,
    };
  }

  async findPendingByCaseAndAgent(caseId: string, agentId: string): Promise<QualityReview | null> {
    return (
      [...this.reviews.values()].find(
        (r) => r.caseId === caseId && r.agentId === agentId && r.status === "pending",
      ) ?? null
    );
  }

  async findLatestByCaseAndAgent(caseId: string, agentId: string): Promise<QualityReview | null> {
    return (
      [...this.reviews.values()]
        .filter((r) => r.caseId === caseId && r.agentId === agentId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
    );
  }

  async listReviews(filters: ListQualityReviewsFilter) {
    let list = [...this.reviews.values()];
    if (filters.agentId) list = list.filter((r) => r.agentId === filters.agentId);
    if (filters.status) list = list.filter((r) => r.status === filters.status);
    if (filters.departmentIds !== null && filters.departmentIds !== undefined) {
      const set = new Set(filters.departmentIds);
      list = list.filter((r) => r.departmentId !== null && set.has(r.departmentId));
    }
    if (filters.minScore !== undefined) {
      list = list.filter((r) => r.cordialityScore !== null && r.cordialityScore >= filters.minScore!);
    }
    if (filters.maxScore !== undefined) {
      list = list.filter((r) => r.cordialityScore !== null && r.cordialityScore <= filters.maxScore!);
    }
    return list.map((r) => ({
      ...r,
      customerLabel: "Cliente test",
      waPhone: "+5939900000",
      waProfileName: null as string | null,
      highFindingCount: (this.findings.get(r.id) ?? []).filter((f) => f.severity === "high").length,
      findingCount: (this.findings.get(r.id) ?? []).length,
    }));
  }

  async list(filters: { status?: string; agentId?: string }): Promise<QualityReview[]> {
    let list = [...this.reviews.values()];
    if (filters.status) list = list.filter((r) => r.status === filters.status);
    if (filters.agentId) list = list.filter((r) => r.agentId === filters.agentId);
    return list;
  }

  async claimNextPending(): Promise<QualityReview | null> {
    const next = [...this.reviews.values()].find(
      (r) => r.status === "pending" && r.startedAt === null,
    );
    if (!next) return null;
    const claimed = { ...next, startedAt: new Date() };
    this.reviews.set(next.id, claimed);
    return claimed;
  }

  async listStuckStartedPending(staleStartedBefore: Date): Promise<QualityReview[]> {
    return [...this.reviews.values()].filter(
      (r) =>
        r.status === "pending" &&
        r.startedAt !== null &&
        r.startedAt < staleStartedBefore,
    );
  }

  async resetAllPendingClaims(): Promise<number> {
    let n = 0;
    for (const [id, r] of this.reviews) {
      if (r.status === "pending" && r.startedAt) {
        this.reviews.set(id, { ...r, startedAt: null });
        n += 1;
      }
    }
    return n;
  }

  eligible: Array<{
    caseId: string;
    conversationId: string;
    agentId: string;
    departmentId: string | null;
  }> = [];

  async listEligibleCasesForAnalysis(filters: {
    from: Date;
    to: Date;
    agentId?: string;
    departmentIds?: string[] | null;
    limit: number;
  }) {
    let list = [...this.eligible];
    if (filters.agentId) list = list.filter((r) => r.agentId === filters.agentId);
    if (filters.departmentIds !== null && filters.departmentIds !== undefined) {
      const set = new Set(filters.departmentIds);
      list = list.filter((r) => r.departmentId !== null && set.has(r.departmentId));
    }
    list = list.filter((row) => {
      const hasUseful = [...this.reviews.values()].some(
        (r) =>
          r.caseId === row.caseId &&
          r.agentId === row.agentId &&
          (r.status === "pending" || r.status === "ready" || r.status === "reviewed"),
      );
      return !hasUseful;
    });
    return list.slice(0, filters.limit);
  }

  async countByStatus(
    status: QualityReview["status"],
    filters?: { agentId?: string; departmentIds?: string[] | null },
  ): Promise<number> {
    let list = [...this.reviews.values()].filter((r) => r.status === status);
    if (filters?.agentId) list = list.filter((r) => r.agentId === filters.agentId);
    if (filters?.departmentIds !== null && filters?.departmentIds !== undefined) {
      const set = new Set(filters.departmentIds);
      list = list.filter((r) => r.departmentId !== null && set.has(r.departmentId));
    }
    return list.length;
  }

  async markReady(reviewId: string, input: MarkReadyInput): Promise<QualityReviewDetail> {
    const review = this.reviews.get(reviewId);
    if (!review) throw new Error("not found");
    const updated: QualityReview = {
      ...review,
      status: "ready",
      cordialityScore: input.cordialityScore,
      efficiencyNotes: input.efficiencyNotes,
      summary: input.summary,
      errorMessage: null,
      modelRaw: input.modelRaw,
      messagesTotal: input.messagesTotal,
      messagesAnalyzed: input.messagesAnalyzed,
      chunkSize: input.chunkSize,
      startedAt: null,
      completedAt: new Date(),
    };
    this.reviews.set(reviewId, updated);
    const findings: QualityFinding[] = input.findings.map((f) => ({
      id: randomUUID(),
      reviewId,
      messageId: f.messageId,
      severity: f.severity,
      category: f.category,
      excerpt: f.excerpt,
      rationale: f.rationale,
      createdAt: new Date(),
    }));
    this.findings.set(reviewId, findings);
    return {
      review: updated,
      findings,
      notes: this.notes.get(reviewId) ?? [],
      customerLabel: "Cliente test",
      waPhone: "+5939900000",
      waProfileName: null,
    };
  }

  async saveChunkProgress(
    reviewId: string,
    input: SaveChunkProgressInput,
  ): Promise<QualityReviewDetail> {
    const review = this.reviews.get(reviewId);
    if (!review) throw new Error("not found");
    const updated: QualityReview = {
      ...review,
      status: "pending",
      cordialityScore: input.provisionalScore,
      efficiencyNotes: input.efficiencyNotes,
      summary: input.summary,
      errorMessage: null,
      modelRaw: input.modelRaw,
      messagesTotal: input.messagesTotal,
      messagesAnalyzed: input.messagesAnalyzed,
      chunkSize: input.chunkSize,
      startedAt: null,
      completedAt: null,
    };
    this.reviews.set(reviewId, updated);
    const findings: QualityFinding[] = input.findings.map((f) => ({
      id: randomUUID(),
      reviewId,
      messageId: f.messageId,
      severity: f.severity,
      category: f.category,
      excerpt: f.excerpt,
      rationale: f.rationale,
      createdAt: new Date(),
    }));
    this.findings.set(reviewId, findings);
    return {
      review: updated,
      findings,
      notes: this.notes.get(reviewId) ?? [],
      customerLabel: "Cliente test",
      waPhone: "+5939900000",
      waProfileName: null,
    };
  }

  async markFailed(reviewId: string, errorMessage?: string): Promise<void> {
    const review = this.reviews.get(reviewId);
    if (!review) return;
    const updated: QualityReview = {
      ...review,
      status: "failed",
      errorMessage: errorMessage ?? null,
      startedAt: null,
      completedAt: new Date(),
    };
    this.reviews.set(reviewId, updated);
  }

  async reopenFailedAsPending(reviewId: string): Promise<QualityReview> {
    const review = this.reviews.get(reviewId);
    if (!review || review.status !== "failed") throw new Error("not failed");
    const updated = {
      ...review,
      status: "pending" as const,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    };
    this.reviews.set(reviewId, updated);
    return updated;
  }

  async markReviewed(reviewId: string): Promise<QualityReview> {
    const review = this.reviews.get(reviewId);
    if (!review) throw new Error("not found");
    const updated = { ...review, status: "reviewed" as const };
    this.reviews.set(reviewId, updated);
    return updated;
  }

  async addCoachingNote(input: AddCoachingNoteInput): Promise<QualityCoachingNote> {
    const note: QualityCoachingNote = {
      id: randomUUID(),
      reviewId: input.reviewId,
      authorAgentId: input.authorAgentId,
      body: input.body,
      ackStatus: "open",
      acknowledgedAt: null,
      createdAt: new Date(),
    };
    const list = this.notes.get(input.reviewId) ?? [];
    list.push(note);
    this.notes.set(input.reviewId, list);
    return note;
  }

  async getAgentStats(): Promise<AgentQualityStats[]> {
    return [];
  }
}
