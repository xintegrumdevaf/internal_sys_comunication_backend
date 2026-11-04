import { randomUUID } from "node:crypto";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { QualityReview } from "../../domain/quality-review.entity";
import type { QualityReviewRepositoryPort } from "../ports/quality-review.repository.port";
import { resolveQualityDepartmentScope } from "../quality-auth";
import type { EnqueueQualityReviewService } from "../services/enqueue-quality-review.service";

const DEFAULT_BATCH_LIMIT = 1;
const MAX_BATCH_LIMIT = 50;

export type BatchEnqueueResult = {
  enqueued: number;
  pendingTotal: number;
  reviews: QualityReview[];
};

/**
 * Encola análisis on-demand para casos cerrados.
 * Si reanalyzeAll: true, resetea a pending las reviews existentes para re-evaluarlas con el prompt actual.
 */
export class BatchEnqueueQualityReviewsUseCase {
  constructor(
    private readonly deps: {
      qualityRepo: QualityReviewRepositoryPort;
      agentRepo: AgentRepositoryPort;
      enqueueService: EnqueueQualityReviewService;
    },
  ) {}

  async execute(input: {
    actor: Agent;
    from: Date;
    to: Date;
    agentId?: string;
    departmentId?: string;
    limit?: number;
    reanalyzeAll?: boolean;
  }): Promise<BatchEnqueueResult> {
    const departmentIds = await resolveQualityDepartmentScope(
      input.actor,
      this.deps.agentRepo,
      input.departmentId,
    );

    if (input.reanalyzeAll) {
      const resetIds = await this.deps.qualityRepo.resetReviewsForReanalysis({
        from: input.from,
        to: input.to,
        agentId: input.agentId,
        departmentIds,
      });

      for (const id of resetIds) {
        this.deps.enqueueService.scheduleRun(id);
      }

      const pendingTotal = await this.deps.qualityRepo.countByStatus("pending", {
        agentId: input.agentId,
        departmentIds,
      });

      return {
        enqueued: resetIds.length,
        pendingTotal,
        reviews: [],
      };
    }

    const limit = Math.min(
      Math.max(input.limit ?? DEFAULT_BATCH_LIMIT, 1),
      MAX_BATCH_LIMIT,
    );

    const eligible = await this.deps.qualityRepo.listEligibleCasesForAnalysis({
      from: input.from,
      to: input.to,
      agentId: input.agentId,
      departmentIds,
      limit,
    });

    const reviews: QualityReview[] = [];
    let enqueued = 0;
    for (const row of eligible) {
      const pending = await this.deps.qualityRepo.findPendingByCaseAndAgent(
        row.caseId,
        row.agentId,
      );
      if (pending) {
        reviews.push(pending);
        continue;
      }

      const review = await this.deps.qualityRepo.createPending({
        conversationId: row.conversationId,
        caseId: row.caseId,
        agentId: row.agentId,
        departmentId: row.departmentId,
        triggerKind: "on_demand",
        idempotencyKey: `${row.caseId}:${row.agentId}:on_demand:${randomUUID()}`,
        chunkSize: this.deps.enqueueService.getChunkSize(),
      });
      this.deps.enqueueService.scheduleRun(review.id);
      reviews.push(review);
      enqueued += 1;
    }

    const pendingTotal = await this.deps.qualityRepo.countByStatus("pending", {
      agentId: input.agentId,
      departmentIds,
    });

    return {
      enqueued,
      pendingTotal,
      reviews,
    };
  }
}
