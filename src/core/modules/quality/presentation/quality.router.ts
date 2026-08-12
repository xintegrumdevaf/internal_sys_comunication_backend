import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../../../shared/http/require-auth";
import type { QualityCoachingNote } from "../domain/quality-coaching-note.entity";
import type { QualityFinding } from "../domain/quality-finding.entity";
import type { QualityReview, QualityReviewListItem } from "../domain/quality-review.entity";
import type {
  AgentQualityStats,
  QualityReviewDetail,
} from "../application/ports/quality-review.repository.port";
import type { ListQualityReviewsUseCase } from "../application/use-cases/list-quality-reviews.use-case";
import type { GetQualityReviewUseCase } from "../application/use-cases/get-quality-review.use-case";
import type { GetAgentQualityStatsUseCase } from "../application/use-cases/get-agent-quality-stats.use-case";
import type { RequestOnDemandReviewUseCase } from "../application/use-cases/request-on-demand-review.use-case";
import type { AddCoachingNoteUseCase } from "../application/use-cases/add-coaching-note.use-case";
import type { MarkReviewReviewedUseCase } from "../application/use-cases/mark-review-reviewed.use-case";
import type { Agent } from "../../departments/domain/agent.entity";
import type { BatchEnqueueQualityReviewsUseCase } from "../application/use-cases/batch-enqueue-quality-reviews.use-case";

export type QualityRouterDeps = {
  listReviews: ListQualityReviewsUseCase;
  getReview: GetQualityReviewUseCase;
  getAgentStats: GetAgentQualityStatsUseCase;
  requestOnDemand: RequestOnDemandReviewUseCase;
  addCoachingNote: AddCoachingNoteUseCase;
  markReviewed: MarkReviewReviewedUseCase;
  batchEnqueue: BatchEnqueueQualityReviewsUseCase;
  getPendingCount: (input: {
    actor: Agent;
    agentId?: string;
    departmentId?: string;
  }) => Promise<number>;
};

function serializeReviewBase(review: QualityReview) {
  return {
    id: review.id,
    conversationId: review.conversationId,
    caseId: review.caseId,
    agentId: review.agentId,
    departmentId: review.departmentId,
    cordialityScore: review.cordialityScore,
    efficiencyNotes: review.efficiencyNotes,
    summary: review.summary,
    errorMessage: review.errorMessage,
    status: review.status,
    trigger: review.triggerKind,
    messagesTotal: review.messagesTotal,
    messagesAnalyzed: review.messagesAnalyzed,
    chunkSize: review.chunkSize,
    startedAt: review.startedAt?.toISOString() ?? null,
    createdAt: review.createdAt.toISOString(),
    completedAt: review.completedAt?.toISOString() ?? null,
  };
}

function serializeListItem(item: QualityReviewListItem) {
  return {
    ...serializeReviewBase(item),
    customerLabel: item.customerLabel,
    waPhone: item.waPhone,
    waProfileName: item.waProfileName,
    highFindingCount: item.highFindingCount,
    findingCount: item.findingCount,
  };
}

function serializeDetail(detail: QualityReviewDetail) {
  return {
    ...serializeReviewBase(detail.review),
    customerLabel: detail.customerLabel,
    waPhone: detail.waPhone,
    waProfileName: detail.waProfileName,
    findings: detail.findings.map(serializeFinding),
    notes: detail.notes.map(serializeNote),
  };
}

function serializeFinding(f: QualityFinding) {
  return {
    id: f.id,
    reviewId: f.reviewId,
    messageId: f.messageId,
    severity: f.severity,
    category: f.category,
    excerpt: f.excerpt,
    rationale: f.rationale,
    createdAt: f.createdAt.toISOString(),
  };
}

function serializeNote(n: QualityCoachingNote) {
  return {
    id: n.id,
    reviewId: n.reviewId,
    authorAgentId: n.authorAgentId,
    body: n.body,
    ackStatus: n.ackStatus,
    acknowledgedAt: n.acknowledgedAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

function serializeStats(s: AgentQualityStats) {
  return {
    agentId: s.agentId,
    agentName: s.agentName,
    casesCompleted: s.casesCompleted,
    closedWithAgentMessages: s.closedWithAgentMessages,
    analyzedCount: s.analyzedCount,
    pendingCount: s.pendingCount,
    failedCount: s.failedCount,
    avgCordialityScore: s.avgCordialityScore,
    criticalReviewCount: s.criticalReviewCount,
    avgFirstHumanReplyMs: s.avgFirstHumanReplyMs,
  };
}

const onDemandBodySchema = z.object({
  caseId: z.string().uuid(),
});

const noteBodySchema = z.object({
  body: z.string().min(1),
});

const patchBodySchema = z.object({
  status: z.literal("reviewed"),
});

const batchBodySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  agentId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

/**
 * Endpoints de supervision de calidad (03_API_CONTRACT.md §C, 07_QUALITY_SUPERVISION.md).
 * Solo manager/admin. Nunca expone modelRaw.
 */
export function createQualityRouter(deps: QualityRouterDeps): Router {
  const router = Router();

  router.get("/api/quality/pending-count", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const count = await deps.getPendingCount({
        actor,
        agentId: typeof req.query.agentId === "string" ? req.query.agentId : undefined,
        departmentId:
          typeof req.query.departmentId === "string" ? req.query.departmentId : undefined,
      });
      res.json({ data: { pendingCount: count } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/quality/agents", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const from = req.query.from
        ? new Date(String(req.query.from))
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = req.query.to ? new Date(String(req.query.to)) : new Date();
      const departmentId =
        typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;

      const data = await deps.getAgentStats.execute({
        actor,
        from,
        to,
        departmentId,
      });
      res.json({ data: data.map(serializeStats) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/quality/reviews", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const status = z
        .enum(["pending", "ready", "failed", "reviewed"])
        .optional()
        .parse(req.query.status);

      const data = await deps.listReviews.execute({
        actor,
        agentId: typeof req.query.agentId === "string" ? req.query.agentId : undefined,
        from: req.query.from ? new Date(String(req.query.from)) : undefined,
        to: req.query.to ? new Date(String(req.query.to)) : undefined,
        minScore:
          req.query.minScore !== undefined ? Number(req.query.minScore) : undefined,
        maxScore:
          req.query.maxScore !== undefined ? Number(req.query.maxScore) : undefined,
        status,
        departmentId:
          typeof req.query.departmentId === "string" ? req.query.departmentId : undefined,
      });
      res.json({ data: data.map(serializeListItem) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/quality/reviews/:id", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const detail = await deps.getReview.execute({
        actor,
        reviewId: req.params.id!,
      });
      res.json({ data: serializeDetail(detail) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/quality/reviews", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const body = onDemandBodySchema.parse(req.body);
      const review = await deps.requestOnDemand.execute({ actor, caseId: body.caseId });
      res.status(200).json({ data: serializeReviewBase(review) });
    } catch (error) {
      next(error);
    }
  });

  /** Encola análisis de casos cerrados sin review útil (secundario; UI usa 1 chat). */
  router.post("/api/quality/analyze-batch", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const body = batchBodySchema.parse(req.body ?? {});
      const from = body.from
        ? new Date(body.from)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = body.to ? new Date(body.to) : new Date();
      const result = await deps.batchEnqueue.execute({
        actor,
        from,
        to,
        agentId: body.agentId,
        departmentId: body.departmentId,
        limit: body.limit ?? 1,
      });
      res.status(200).json({
        data: {
          enqueued: result.enqueued,
          pendingTotal: result.pendingTotal,
          reviews: result.reviews.map(serializeReviewBase),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/quality/reviews/:id/notes", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      const body = noteBodySchema.parse(req.body);
      const note = await deps.addCoachingNote.execute({
        actor,
        reviewId: req.params.id!,
        body: body.body,
      });
      res.status(201).json({ data: serializeNote(note) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/quality/reviews/:id", async (req, res, next) => {
    try {
      const actor = requireRole(req, ["manager", "admin"]);
      patchBodySchema.parse(req.body);
      const review = await deps.markReviewed.execute({
        actor,
        reviewId: req.params.id!,
      });
      res.json({ data: serializeReviewBase(review) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
