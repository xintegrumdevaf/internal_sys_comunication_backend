import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Case } from "../../src/core/modules/cases/domain/case.entity";
import type { Agent } from "../../src/core/modules/departments/domain/agent.entity";
import { FakeAIProvider } from "../../src/core/modules/ai/infrastructure/fake/fake-ai.provider";
import { EnqueueQualityReviewService } from "../../src/core/modules/quality/application/services/enqueue-quality-review.service";
import { RunQualityAnalysisUseCase } from "../../src/core/modules/quality/application/use-cases/run-quality-analysis.use-case";
import { ListQualityReviewsUseCase } from "../../src/core/modules/quality/application/use-cases/list-quality-reviews.use-case";
import { RequestOnDemandReviewUseCase } from "../../src/core/modules/quality/application/use-cases/request-on-demand-review.use-case";
import { AddCoachingNoteUseCase } from "../../src/core/modules/quality/application/use-cases/add-coaching-note.use-case";
import { BatchEnqueueQualityReviewsUseCase } from "../../src/core/modules/quality/application/use-cases/batch-enqueue-quality-reviews.use-case";
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
import type { QualityReview } from "../../src/core/modules/quality/domain/quality-review.entity";
import type { QualityFinding } from "../../src/core/modules/quality/domain/quality-finding.entity";
import type { QualityCoachingNote } from "../../src/core/modules/quality/domain/quality-coaching-note.entity";
import { MessageRepositoryFake } from "../support/fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../support/agent-audit.fakes";
import { silentLogger } from "../support/silent-logger";
import type { CaseAggregate, CaseRepositoryPort } from "../../src/core/modules/cases/application/ports/case.repository.port";
import { emptyContextFor } from "../../src/core/modules/cases/domain/contexts/case-context";

class QualityReviewRepositoryFake implements QualityReviewRepositoryPort {
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

  claimQueue: string[] = [];

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

function makeCase(overrides: Partial<Case> = {}): Case {
  const now = new Date();
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    departmentId: randomUUID(),
    assignedAgentId: randomUUID(),
    workflowType: "SUPPORT_INTERNET",
    status: "COMPLETED",
    context: emptyContextFor("SUPPORT_INTERNET"),
    version: 1,
    lastActivityAt: now,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Etapa 10 — quality supervision", () => {
  it("RunQualityAnalysis filtra messageIds inventados y marca ready con score", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const ai = new FakeAIProvider();
    const caseEntity = makeCase();
    const realMsg = messageRepo.seedText(caseEntity.conversationId, "hola agente", {
      caseId: caseEntity.id,
      author: "customer",
    });
    const agentMsg = messageRepo.seedText(caseEntity.conversationId, "en que ayudo", {
      caseId: caseEntity.id,
      author: "agent",
      agentId: caseEntity.assignedAgentId,
      direction: "outbound",
    });

    const inventedId = randomUUID();
    ai.analyzeImpl = async () => ({
      cordialityScore: 72,
      summary: "Atencion aceptable",
      findings: [
        {
          messageId: agentMsg.id,
          severity: "low",
          category: "other",
          excerpt: "en que ayudo",
          rationale: "tono correcto",
        },
        {
          messageId: inventedId,
          severity: "high",
          category: "aggression",
          excerpt: "fake",
          rationale: "inventado",
        },
      ],
    });

    const review = await qualityRepo.createPending({
      conversationId: caseEntity.conversationId,
      caseId: caseEntity.id,
      agentId: caseEntity.assignedAgentId!,
      departmentId: caseEntity.departmentId,
      triggerKind: "auto_case_closed",
      idempotencyKey: `${caseEntity.id}:${caseEntity.assignedAgentId}:auto`,
    });

    const useCase = new RunQualityAnalysisUseCase({
      qualityRepo,
      messageRepo,
      aiProvider: ai,
      logger: silentLogger,
    });
    const result = await useCase.execute(review.id);

    expect(result?.review.status).toBe("ready");
    expect(result?.review.cordialityScore).toBe(72);
    expect(result?.findings).toHaveLength(1);
    expect(result?.findings[0]?.messageId).toBe(agentMsg.id);
    expect(result?.findings.some((f) => f.messageId === inventedId)).toBe(false);
    expect(realMsg.id).toBeTruthy();
  });

  it("análisis por tramos: pending parcial y ready con valoración total al completar", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const ai = new FakeAIProvider();
    const caseEntity = makeCase();
    // chunk mínimo normativo = 10; 25 msgs → 3 tramos (10+10+5)
    for (let i = 0; i < 25; i++) {
      messageRepo.seedText(caseEntity.conversationId, `msg-${i}`, {
        caseId: caseEntity.id,
        author: i % 2 === 0 ? "customer" : "agent",
        agentId: i % 2 === 1 ? caseEntity.assignedAgentId : null,
        direction: i % 2 === 1 ? "outbound" : "inbound",
      });
    }

    let call = 0;
    ai.analyzeImpl = async (input) => {
      call += 1;
      const agentInChunk = input.messages.find((m) => m.author === "agent");
      return {
        cordialityScore: call === 1 ? 40 : call === 2 ? 60 : 80,
        summary: `Síntesis tramo ${call}`,
        findings:
          call === 2 && agentInChunk
            ? [
                {
                  messageId: agentInChunk.messageId,
                  severity: "high" as const,
                  category: "neglect" as const,
                  excerpt: "mal",
                  rationale: "descuido",
                },
              ]
            : [],
      };
    };

    const review = await qualityRepo.createPending({
      conversationId: caseEntity.conversationId,
      caseId: caseEntity.id,
      agentId: caseEntity.assignedAgentId!,
      departmentId: caseEntity.departmentId,
      triggerKind: "auto_case_closed",
      idempotencyKey: `${caseEntity.id}:${caseEntity.assignedAgentId}:auto`,
      chunkSize: 10,
    });

    const useCase = new RunQualityAnalysisUseCase({
      qualityRepo,
      messageRepo,
      aiProvider: ai,
      logger: silentLogger,
      chunkSize: 10,
    });

    const mid1 = await useCase.execute(review.id);
    expect(mid1?.review.status).toBe("pending");
    expect(mid1?.review.messagesAnalyzed).toBe(10);
    expect(mid1?.review.messagesTotal).toBe(25);

    const mid2 = await useCase.execute(review.id);
    expect(mid2?.review.status).toBe("pending");
    expect(mid2?.review.messagesAnalyzed).toBe(20);

    const done = await useCase.execute(review.id);
    expect(done?.review.status).toBe("ready");
    expect(done?.review.messagesAnalyzed).toBe(25);
    expect(done?.review.cordialityScore).toBe(60); // avg 40,60,80
    expect(done?.review.summary).toContain("Valoración total: 60/100");
    expect(done?.review.summary).toContain("Fallos graves");
    expect(done?.findings.some((f) => f.severity === "high")).toBe(true);
    expect(call).toBe(3);
  });

  it("Enqueue auto es idempotente por caseId:agentId:auto", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const ai = new FakeAIProvider();
    const caseEntity = makeCase();
    messageRepo.seedText(caseEntity.conversationId, "respuesta humana", {
      caseId: caseEntity.id,
      author: "agent",
      agentId: caseEntity.assignedAgentId,
      direction: "outbound",
    });

    const runQualityAnalysis = new RunQualityAnalysisUseCase({
      qualityRepo,
      messageRepo,
      aiProvider: ai,
      logger: silentLogger,
    });
    const enqueue = new EnqueueQualityReviewService({
      qualityRepo,
      messageRepo,
      runQualityAnalysis,
      logger: silentLogger,
    });

    const first = await enqueue.tryAutoEnqueue(caseEntity);
    const second = await enqueue.tryAutoEnqueue(caseEntity);

    expect(first).not.toBeNull();
    expect(second?.id).toBe(first!.id);
    expect(second?.idempotencyKey).toBe(`${caseEntity.id}:${caseEntity.assignedAgentId}:auto`);
    expect([...qualityRepo.reviews.values()]).toHaveLength(1);
  });

  it("Fake AI produce review ready con score en rango 0-100", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const ai = new FakeAIProvider();
    const caseEntity = makeCase();
    messageRepo.seedText(caseEntity.conversationId, "ok", {
      caseId: caseEntity.id,
      author: "agent",
      agentId: caseEntity.assignedAgentId,
      direction: "outbound",
    });

    const review = await qualityRepo.createPending({
      conversationId: caseEntity.conversationId,
      caseId: caseEntity.id,
      agentId: caseEntity.assignedAgentId!,
      departmentId: caseEntity.departmentId,
      triggerKind: "auto_case_closed",
      idempotencyKey: `${caseEntity.id}:auto-test`,
    });

    const result = await new RunQualityAnalysisUseCase({
      qualityRepo,
      messageRepo,
      aiProvider: ai,
      logger: silentLogger,
    }).execute(review.id);

    expect(result?.review.status).toBe("ready");
    expect(result?.review.cordialityScore).toBe(85);
    expect(result?.review.cordialityScore).toBeGreaterThanOrEqual(0);
    expect(result?.review.cordialityScore).toBeLessThanOrEqual(100);
  });

  it("Manager no lista reviews de otro departamento; admin si", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const agentRepo = new AgentRepositoryFake();
    const deptA = randomUUID();
    const deptB = randomUUID();

    const manager = agentRepo.seed({
      name: "Mgr A",
      email: "mgr-a@test.local",
      role: "manager",
      primaryDepartmentId: deptA,
    });
    await agentRepo.addMembership(manager.id, deptA);

    const admin = agentRepo.seed({
      name: "Admin",
      email: "admin@test.local",
      role: "admin",
    });

    await qualityRepo.createPending({
      conversationId: randomUUID(),
      caseId: randomUUID(),
      agentId: randomUUID(),
      departmentId: deptA,
      triggerKind: "auto_case_closed",
      idempotencyKey: "a-auto",
    });
    await qualityRepo.createPending({
      conversationId: randomUUID(),
      caseId: randomUUID(),
      agentId: randomUUID(),
      departmentId: deptB,
      triggerKind: "auto_case_closed",
      idempotencyKey: "b-auto",
    });

    const list = new ListQualityReviewsUseCase({ qualityRepo, agentRepo });

    const asManager = await list.execute({ actor: manager });
    expect(asManager).toHaveLength(1);
    expect(asManager[0]?.departmentId).toBe(deptA);

    const asAdmin = await list.execute({ actor: admin });
    expect(asAdmin).toHaveLength(2);
  });

  it("On-demand con pending existente no duplica", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const agentRepo = new AgentRepositoryFake();
    const ai = new FakeAIProvider();
    const caseEntity = makeCase();

    const manager = agentRepo.seed({
      name: "Mgr",
      email: "mgr@test.local",
      role: "manager",
      primaryDepartmentId: caseEntity.departmentId,
    });
    await agentRepo.addMembership(manager.id, caseEntity.departmentId!);

    const existing = await qualityRepo.createPending({
      conversationId: caseEntity.conversationId,
      caseId: caseEntity.id,
      agentId: caseEntity.assignedAgentId!,
      departmentId: caseEntity.departmentId,
      triggerKind: "on_demand",
      idempotencyKey: `${caseEntity.id}:${caseEntity.assignedAgentId}:on_demand:existing`,
    });

    const caseRepo = {
      async findById(id: string): Promise<CaseAggregate | null> {
        if (id !== caseEntity.id) return null;
        return {
          case: caseEntity,
          workflowInstance: {
            id: randomUUID(),
            caseId: caseEntity.id,
            workflowType: caseEntity.workflowType,
            currentState: "HUMAN_ACTIVE",
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        };
      },
    } as Pick<CaseRepositoryPort, "findById"> as CaseRepositoryPort;

    const runQualityAnalysis = new RunQualityAnalysisUseCase({
      qualityRepo,
      messageRepo,
      aiProvider: ai,
      logger: silentLogger,
    });
    const enqueue = new EnqueueQualityReviewService({
      qualityRepo,
      messageRepo,
      runQualityAnalysis,
      logger: silentLogger,
    });

    const useCase = new RequestOnDemandReviewUseCase({
      qualityRepo,
      caseRepo,
      agentRepo,
      enqueueService: enqueue,
    });

    const result = await useCase.execute({ actor: manager, caseId: caseEntity.id });
    expect(result.id).toBe(existing.id);
    expect([...qualityRepo.reviews.values()]).toHaveLength(1);
  });

  it("Coaching note queda en audit_event", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const agentRepo = new AgentRepositoryFake();
    const auditRepo = new AuditRepositoryFake();
    const deptId = randomUUID();

    const manager = agentRepo.seed({
      name: "Mgr",
      email: "coach@test.local",
      role: "manager",
      primaryDepartmentId: deptId,
    });
    await agentRepo.addMembership(manager.id, deptId);

    const review = await qualityRepo.createPending({
      conversationId: randomUUID(),
      caseId: randomUUID(),
      agentId: randomUUID(),
      departmentId: deptId,
      triggerKind: "auto_case_closed",
      idempotencyKey: "coach-1",
    });

    const note = await new AddCoachingNoteUseCase({
      qualityRepo,
      agentRepo,
      auditRepo,
    }).execute({
      actor: manager as Agent,
      reviewId: review.id,
      body: "Hablar tono con el cliente",
    });

    expect(note.body).toContain("tono");
    expect(auditRepo.events.some((e) => e.action === "QUALITY_COACHING_NOTE_CREATED")).toBe(true);
  });

  it("no encola auto si no hay mensajes de agente", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const ai = new FakeAIProvider();
    const caseEntity = makeCase();
    messageRepo.seedText(caseEntity.conversationId, "solo cliente", {
      caseId: caseEntity.id,
      author: "customer",
    });

    const enqueue = new EnqueueQualityReviewService({
      qualityRepo,
      messageRepo,
      runQualityAnalysis: new RunQualityAnalysisUseCase({
        qualityRepo,
        messageRepo,
        aiProvider: ai,
        logger: silentLogger,
      }),
      logger: silentLogger,
    });

    const result = await enqueue.tryAutoEnqueue(caseEntity);
    expect(result).toBeNull();
    expect(qualityRepo.reviews.size).toBe(0);
  });

  it("batch encola elegibles sin duplicar pending", async () => {
    const qualityRepo = new QualityReviewRepositoryFake();
    const agentRepo = new AgentRepositoryFake();
    const deptId = randomUUID();
    const manager = agentRepo.seed({
      name: "Mgr Batch",
      email: "mgr-batch@test.local",
      role: "manager",
      primaryDepartmentId: deptId,
    });
    await agentRepo.addMembership(manager.id, deptId);

    const caseA = makeCase({ assignedAgentId: manager.id, departmentId: deptId });
    const caseB = makeCase({ assignedAgentId: manager.id, departmentId: deptId });
    qualityRepo.eligible = [
      {
        caseId: caseA.id,
        conversationId: caseA.conversationId,
        agentId: manager.id,
        departmentId: deptId,
      },
      {
        caseId: caseB.id,
        conversationId: caseB.conversationId,
        agentId: manager.id,
        departmentId: deptId,
      },
    ];

    const enqueue = new EnqueueQualityReviewService({
      qualityRepo,
      messageRepo: new MessageRepositoryFake(),
      runQualityAnalysis: new RunQualityAnalysisUseCase({
        qualityRepo,
        messageRepo: new MessageRepositoryFake(),
        aiProvider: new FakeAIProvider(),
        logger: silentLogger,
      }),
      logger: silentLogger,
    });
    // No drenar: el batch solo encola; si corre el worker con 0 msgs marca failed
    // y vuelve a ser elegible.
    enqueue.scheduleRun = () => undefined;

    const batch = new BatchEnqueueQualityReviewsUseCase({
      qualityRepo,
      agentRepo,
      enqueueService: enqueue,
    });

    const first = await batch.execute({
      actor: manager as Agent,
      from: new Date("2020-01-01"),
      to: new Date("2030-01-01"),
      limit: 5,
    });
    expect(first.enqueued).toBe(2);
    expect(qualityRepo.reviews.size).toBe(2);

    const second = await batch.execute({
      actor: manager as Agent,
      from: new Date("2020-01-01"),
      to: new Date("2030-01-01"),
      limit: 5,
    });
    expect(second.enqueued).toBe(0);
    expect(qualityRepo.reviews.size).toBe(2);
  });
});
