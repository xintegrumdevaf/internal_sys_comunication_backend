import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { QualityReview } from "../../domain/quality-review.entity";
import type { QualityReviewRepositoryPort } from "../ports/quality-review.repository.port";
import { assertCanAccessQualityDepartment } from "../quality-auth";
import type { EnqueueQualityReviewService } from "../services/enqueue-quality-review.service";

/**
 * Analizar este chat (on-demand).
 * - ready/reviewed → no llama IA; devuelve la review existente.
 * - pending → re-despierta el worker.
 * - failed → reabre el mismo registro a pending.
 * - sin review → crea pending on_demand.
 */
export class RequestOnDemandReviewUseCase {
  constructor(
    private readonly deps: {
      qualityRepo: QualityReviewRepositoryPort;
      caseRepo: CaseRepositoryPort;
      agentRepo: AgentRepositoryPort;
      enqueueService: EnqueueQualityReviewService;
    },
  ) {}

  async execute(input: { actor: Agent; caseId: string }): Promise<QualityReview> {
    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) throw notFound(`Caso ${input.caseId} no encontrado`);

    await assertCanAccessQualityDepartment(
      input.actor,
      aggregate.case.departmentId,
      this.deps.agentRepo,
    );

    const agentId = aggregate.case.assignedAgentId;
    if (!agentId) {
      throw notFound(`El caso ${input.caseId} no tiene agente asignado para analizar`);
    }

    const latest = await this.deps.qualityRepo.findLatestByCaseAndAgent(
      aggregate.case.id,
      agentId,
    );

    if (latest?.status === "ready" || latest?.status === "reviewed") {
      return latest;
    }

    if (latest?.status === "pending") {
      this.deps.enqueueService.scheduleRun(latest.id);
      return latest;
    }

    if (latest?.status === "failed") {
      const reopened = await this.deps.qualityRepo.reopenFailedAsPending(latest.id);
      this.deps.enqueueService.scheduleRun(reopened.id);
      return reopened;
    }

    const hasAgent = await this.deps.enqueueService.hasAgentMessages(aggregate.case.id);
    if (!hasAgent) {
      throw businessError("El caso no tiene mensajes de agente para analizar");
    }

    const idempotencyKey = `${aggregate.case.id}:${agentId}:on_demand`;
    const review = await this.deps.qualityRepo.createPending({
      conversationId: aggregate.case.conversationId,
      caseId: aggregate.case.id,
      agentId,
      departmentId: aggregate.case.departmentId,
      triggerKind: "on_demand",
      idempotencyKey,
      chunkSize: this.deps.enqueueService.getChunkSize(),
    });

    this.deps.enqueueService.scheduleRun(review.id);
    return review;
  }
}
