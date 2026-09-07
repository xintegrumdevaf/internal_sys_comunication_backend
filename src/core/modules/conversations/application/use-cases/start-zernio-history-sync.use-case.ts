import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { Logger } from "../../../../../shared/logging/logger";
import type { ZernioHistoryPort } from "../ports/zernio-history.port";
import type { ZernioHistorySyncWorker } from "../../infrastructure/queue/zernio-history-sync.worker";
import {
  ZERNIO_HISTORY_QUEUE_KEY,
  ZERNIO_HISTORY_STATUS_KEY,
} from "../../infrastructure/queue/zernio-history-sync.worker";
import type {
  ZernioSyncJob,
  ZernioSyncProgress,
} from "../../domain/zernio-history.types";

export class StartZernioHistorySyncUseCase {
  constructor(
    private readonly redisClient: Redis | null,
    private readonly zernioHistory: ZernioHistoryPort,
    private readonly worker: ZernioHistorySyncWorker,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<{ alreadyRunning: boolean; progress: ZernioSyncProgress }> {
    if (!this.redisClient) {
      throw new Error("Redis es requerido para la sincronizacion historica en cola");
    }

    const rawStatus = await this.redisClient.get(ZERNIO_HISTORY_STATUS_KEY);
    if (rawStatus) {
      try {
        const existing = JSON.parse(rawStatus) as ZernioSyncProgress;
        if (existing.status === "IN_PROGRESS") {
          this.logger.warn({ jobId: existing.jobId }, "Sincronizacion historica ya en progreso");
          return { alreadyRunning: true, progress: existing };
        }
      } catch {
        // ignora parse error y procede
      }
    }

    this.logger.info("Iniciando busqueda de conversaciones en Zernio para sincronizacion");
    const conversations = await this.zernioHistory.fetchAllConversations();

    const jobId = randomUUID();
    const initialProgress: ZernioSyncProgress = {
      jobId,
      status: conversations.length === 0 ? "COMPLETED" : "IN_PROGRESS",
      totalConversations: conversations.length,
      processedConversations: 0,
      failedConversations: 0,
      totalMessagesImported: 0,
      totalMessagesSkipped: 0,
      currentPhone: null,
      startedAt: new Date().toISOString(),
      finishedAt: conversations.length === 0 ? new Date().toISOString() : null,
      errors: [],
    };

    await this.redisClient.set(
      ZERNIO_HISTORY_STATUS_KEY,
      JSON.stringify(initialProgress),
      "EX",
      86400 * 7,
    );

    if (conversations.length === 0) {
      this.logger.info("No se encontraron conversaciones historicas en Zernio");
      return { alreadyRunning: false, progress: initialProgress };
    }

    // Limpiar cola previa si hubiera quedado remanente
    await this.redisClient.del(ZERNIO_HISTORY_QUEUE_KEY);

    // Encolar trabajos individuales
    for (const conv of conversations) {
      const job: ZernioSyncJob = {
        jobId,
        zernioConversationId: conv.id,
        participantId: conv.participantId,
        participantName: conv.participantName,
        updatedTime: conv.updatedTime,
        attempt: 1,
      };
      await this.redisClient.rpush(ZERNIO_HISTORY_QUEUE_KEY, JSON.stringify(job));
    }

    this.logger.info(
      { jobId, total: conversations.length },
      "Trabajos de conversacion encolados en Redis con exito",
    );

    // Disparar procesamiento asíncrono
    this.worker.triggerProcessing();

    return { alreadyRunning: false, progress: initialProgress };
  }
}
