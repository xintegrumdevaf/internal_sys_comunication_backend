import type Redis from "ioredis";
import type { Logger } from "../../../../../shared/logging/logger";
import type { ProcessCampaignBatchUseCase } from "../../application/use-cases/process-campaign-batch.use-case";
import type { CampaignQueuePort } from "../../application/use-cases/start-campaign.use-case";

export class CampaignWorkerService implements CampaignQueuePort {
  private isProcessing = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly queueKey = "queue:campaign:jobs";

  constructor(
    private readonly redisClient: Redis | null,
    private readonly processBatchUseCase: ProcessCampaignBatchUseCase,
    private readonly logger: Logger,
  ) {}

  async enqueueCampaignJob(campaignId: string): Promise<void> {
    if (this.redisClient) {
      await this.redisClient.rpush(this.queueKey, campaignId);
    }
    this.logger.info({ campaignId }, "Trabajo de campaña encolado en Redis");
    this.triggerProcessing();
  }

  startWorker(pollIntervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processQueue().catch((err) => {
        this.logger.error({ err }, "Error inesperado en worker de campañas");
      });
    }, pollIntervalMs);
  }

  stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private triggerProcessing(): void {
    setImmediate(() => {
      this.processQueue().catch((err) => {
        this.logger.error({ err }, "Error procesando cola de campañas");
      });
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      let campaignId: string | null = null;

      if (this.redisClient) {
        campaignId = await this.redisClient.lpop(this.queueKey);
      }

      if (!campaignId) {
        this.isProcessing = false;
        return;
      }

      this.logger.info({ campaignId }, "Iniciando procesamiento de lote de campaña");
      const result = await this.processBatchUseCase.execute(campaignId);

      if (!result.finished && !result.stoppedReason) {
        // Re-encolar si aún quedan pendientes y no fue suspendida/cancelada
        if (this.redisClient) {
          await this.redisClient.rpush(this.queueKey, campaignId);
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, "Fallo en ejecución de lote de campaña por worker");
    } finally {
      this.isProcessing = false;
    }
  }
}

/** Fake en memoria para tests. */
export class CampaignQueueFake implements CampaignQueuePort {
  readonly enqueuedIds: string[] = [];

  constructor(private readonly processBatchUseCase?: ProcessCampaignBatchUseCase) {}

  async enqueueCampaignJob(campaignId: string): Promise<void> {
    this.enqueuedIds.push(campaignId);
    if (this.processBatchUseCase) {
      await this.processBatchUseCase.execute(campaignId);
    }
  }
}
