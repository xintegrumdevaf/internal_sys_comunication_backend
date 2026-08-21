import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../../cases/domain/case.entity";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";
import type { QualityReview } from "../../domain/quality-review.entity";
import type { QualityReviewRepositoryPort } from "../ports/quality-review.repository.port";
import type { RunQualityAnalysisUseCase } from "../use-cases/run-quality-analysis.use-case";

/**
 * Worker durable de analisis de calidad (07_QUALITY_SUPERVISION.md §4).
 * - 1 job a la vez (Ollama).
 * - Claim via Postgres FOR UPDATE SKIP LOCKED.
 * - reclaimPending() al boot recupera pending huérfanos tras reinicio.
 */
export class EnqueueQualityReviewService {
  private draining = false;
  private wake: (() => void) | null = null;
  private readonly qualityTimeoutMs: number;
  private readonly chunkSize: number;

  constructor(
    private readonly deps: {
      qualityRepo: QualityReviewRepositoryPort;
      messageRepo: MessageRepositoryPort;
      runQualityAnalysis: RunQualityAnalysisUseCase;
      logger: Logger;
      qualityTimeoutMs?: number;
      chunkSize?: number;
    },
  ) {
    this.qualityTimeoutMs = deps.qualityTimeoutMs ?? 600_000;
    this.chunkSize = deps.chunkSize ?? 40;
  }

  async hasAgentMessages(caseId: string): Promise<boolean> {
    const messages = await this.deps.messageRepo.listByCaseAuthors(caseId, ["agent"]);
    return messages.length > 0;
  }

  async tryAutoEnqueue(caseEntity: Case): Promise<QualityReview | null> {
    const agentId = caseEntity.assignedAgentId;
    if (!agentId) return null;

    const hasAgent = await this.hasAgentMessages(caseEntity.id);
    if (!hasAgent) return null;

    const idempotencyKey = `${caseEntity.id}:${agentId}:auto`;
    const review = await this.deps.qualityRepo.createPending({
      conversationId: caseEntity.conversationId,
      caseId: caseEntity.id,
      agentId,
      departmentId: caseEntity.departmentId,
      triggerKind: "auto_case_closed",
      idempotencyKey,
      chunkSize: this.chunkSize,
    });

    this.scheduleRun(review.id);
    return review;
  }

  /** Tamaño de tramo configurado (env). */
  getChunkSize(): number {
    return this.chunkSize;
  }

  /** Despierta el drenado; el claim real es por DB. */
  scheduleRun(reviewId: string): void {
    this.deps.logger.info({ reviewId }, "analisis de calidad solicitado (worker durable)");
    this.wakeDrain();
  }

  /**
   * Al arrancar: libera claims del proceso anterior y drena pending.
   */
  async reclaimPending(): Promise<void> {
    const reset = await this.deps.qualityRepo.resetAllPendingClaims();
    if (reset > 0) {
      this.deps.logger.info({ reset }, "claims pending liberados tras arranque");
    }
    this.wakeDrain();
  }

  private stopped = false;

  stop(): void {
    this.stopped = true;
    if (this.wake) {
      this.wake();
      this.wake = null;
    }
  }

  private wakeDrain(): void {
    if (this.stopped) return;
    if (this.wake) {
      this.wake();
      this.wake = null;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.stopped) break;
        await this.failStaleClaims();
        if (this.stopped) break;

        const claimed = await this.deps.qualityRepo.claimNextPending();
        if (this.stopped) break;
        if (!claimed) {
          await this.waitForWake(2_000);
          if (this.stopped) break;
          const again = await this.deps.qualityRepo.claimNextPending();
          if (!again || this.stopped) break;
          await this.runClaimed(again);
          continue;
        }
        await this.runClaimed(claimed);
      }
    } finally {
      this.draining = false;
    }
  }

  private async failStaleClaims(): Promise<void> {
    const staleBefore = new Date(Date.now() - this.qualityTimeoutMs - 30_000);
    const stale = await this.deps.qualityRepo.listStuckStartedPending(staleBefore);
    for (const review of stale) {
      await this.deps.qualityRepo.markFailed(
        review.id,
        `Watchdog: timeout de analisis (${this.qualityTimeoutMs}ms)`,
      );
      this.deps.logger.warn({ reviewId: review.id }, "quality_review failed por watchdog");
    }
  }

  private async runClaimed(review: QualityReview): Promise<void> {
    const started = Date.now();
    try {
      await this.deps.runQualityAnalysis.execute(review.id);
      this.deps.logger.info(
        { reviewId: review.id, durationMs: Date.now() - started },
        "analisis de calidad terminado",
      );
    } catch (err) {
      this.deps.logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          reviewId: review.id,
          durationMs: Date.now() - started,
        },
        "fallo en analisis de calidad (no afecta el caso)",
      );
    }
  }

  private waitForWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
