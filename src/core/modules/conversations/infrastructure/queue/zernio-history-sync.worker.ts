import type Redis from "ioredis";
import type { Logger } from "../../../../../shared/logging/logger";
import type { ConversationRepositoryPort } from "../../application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../application/ports/message.repository.port";
import type { ZernioHistoryPort } from "../../application/ports/zernio-history.port";
import type {
  ZernioSyncJob,
  ZernioSyncProgress,
} from "../../domain/zernio-history.types";
import type { MessageAuthor } from "../../domain/message.entity";

export const ZERNIO_HISTORY_QUEUE_KEY = "queue:zernio:history_sync";
export const ZERNIO_HISTORY_STATUS_KEY = "sync:zernio:history:status";

export class ZernioHistorySyncWorker {
  private isProcessing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redisClient: Redis | null,
    private readonly historyGateway: ZernioHistoryPort,
    private readonly conversationRepo: ConversationRepositoryPort,
    private readonly messageRepo: MessageRepositoryPort,
    private readonly logger: Logger,
  ) {}

  startWorker(pollIntervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processQueue().catch((err) => {
        this.logger.error({ err }, "Error inesperado en worker de sincronizacion Zernio");
      });
    }, pollIntervalMs);
  }

  stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  triggerProcessing(): void {
    setImmediate(() => {
      this.processQueue().catch((err) => {
        this.logger.error({ err }, "Error al disparar procesamiento de cola Zernio");
      });
    });
  }

  async getProgress(): Promise<ZernioSyncProgress | null> {
    if (!this.redisClient) return null;
    const raw = await this.redisClient.get(ZERNIO_HISTORY_STATUS_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ZernioSyncProgress;
    } catch {
      return null;
    }
  }

  async saveProgress(progress: ZernioSyncProgress): Promise<void> {
    if (!this.redisClient) return;
    await this.redisClient.set(
      ZERNIO_HISTORY_STATUS_KEY,
      JSON.stringify(progress),
      "EX",
      86400 * 7, // 7 días de retención
    );
  }

  async processQueue(): Promise<void> {
    if (this.isProcessing || !this.redisClient) return;
    this.isProcessing = true;

    try {
      const rawJob = await this.redisClient.lpop(ZERNIO_HISTORY_QUEUE_KEY);
      if (!rawJob) {
        this.isProcessing = false;
        return;
      }

      let job: ZernioSyncJob;
      try {
        job = JSON.parse(rawJob) as ZernioSyncJob;
      } catch (err) {
        this.logger.error({ err, rawJob }, "Payload de trabajo corrupto en cola Zernio");
        this.isProcessing = false;
        return;
      }

      const progress = await this.getProgress();
      if (progress && progress.status === "IN_PROGRESS") {
        progress.currentPhone = job.participantId;
        await this.saveProgress(progress);
      }

      this.logger.info(
        { phone: job.participantId, zernioConvId: job.zernioConversationId, attempt: job.attempt },
        "Procesando sincronizacion de conversacion historica Zernio",
      );

      try {
        await this.processSingleConversation(job);

        // Actualizar progreso exitoso
        const currentProgress = await this.getProgress();
        if (currentProgress && currentProgress.jobId === job.jobId) {
          currentProgress.processedConversations++;
          await this.saveProgress(currentProgress);
        }
      } catch (error) {
        this.logger.error(
          { err: error, phone: job.participantId, attempt: job.attempt },
          "Fallo al sincronizar conversacion individual",
        );

        if (job.attempt < 3) {
          job.attempt++;
          this.logger.warn(
            { phone: job.participantId, nextAttempt: job.attempt },
            "Reencolando conversacion para reintento",
          );
          await this.redisClient.rpush(ZERNIO_HISTORY_QUEUE_KEY, JSON.stringify(job));
        } else {
          // Registro de fallo definitivo en progreso
          const currentProgress = await this.getProgress();
          if (currentProgress && currentProgress.jobId === job.jobId) {
            currentProgress.failedConversations++;
            currentProgress.errors.push({
              phone: job.participantId,
              conversationId: job.zernioConversationId,
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            });
            await this.saveProgress(currentProgress);
          }
        }
      }

      // Verificar si la cola se vació
      const remainingCount = await this.redisClient.llen(ZERNIO_HISTORY_QUEUE_KEY);
      if (remainingCount === 0) {
        const finalProgress = await this.getProgress();
        if (finalProgress && finalProgress.status === "IN_PROGRESS") {
          finalProgress.status =
            finalProgress.failedConversations > 0 ? "PARTIALLY_FAILED" : "COMPLETED";
          finalProgress.currentPhone = null;
          finalProgress.finishedAt = new Date().toISOString();
          await this.saveProgress(finalProgress);
          this.logger.info(
            {
              status: finalProgress.status,
              processed: finalProgress.processedConversations,
              failed: finalProgress.failedConversations,
              messagesImported: finalProgress.totalMessagesImported,
            },
            "Sincronizacion historica de Zernio finalizada",
          );
        }
      } else {
        // Seguir vaciando con una leve pausa (200ms) para respetar rate limits de la API de Zernio y evitar ráfagas de 429
        setTimeout(() => {
          this.processQueue().catch((e) => {
            this.logger.error({ err: e }, "Error en bucle continuo de procesamiento");
          });
        }, 200);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processSingleConversation(job: ZernioSyncJob): Promise<void> {
    const conv = await this.conversationRepo.findOrCreateByWaPhone(job.participantId);

    if (job.participantName && !conv.waProfileName) {
      await this.conversationRepo.setWaProfileName(conv.id, job.participantName);
    }

    const messages = await this.historyGateway.fetchMessagesForConversation(
      job.zernioConversationId,
    );

    let importedCount = 0;
    let skippedCount = 0;
    let latestDate: Date | null = null;

    for (const msg of messages) {
      const msgDate = new Date(msg.createdAt);
      if (!latestDate || msgDate > latestDate) {
        latestDate = msgDate;
      }

      const direction = msg.direction === "outgoing" ? "outbound" : "inbound";
      let author: MessageAuthor = "customer";
      if (direction === "outbound") {
        author = msg.sentVia === "api" ? "system" : "agent";
      }

      const firstAttachment = msg.attachments?.[0];
      const type =
        firstAttachment?.type || (msg.attachments && msg.attachments.length > 0 ? "image" : "text");

      const result = await this.messageRepo.insertHistorical({
        conversationId: conv.id,
        direction,
        author,
        externalId: msg.id,
        body: msg.message || (firstAttachment ? `[${type}]` : ""),
        type,
        mediaId: firstAttachment?.url ?? null,
        mimeType: firstAttachment?.mimeType ?? null,
        filename: firstAttachment?.filename ?? null,
        status: msg.status,
        errorMessage: msg.errorMessage,
        createdAt: msgDate,
      });

      if (result.isDuplicate) {
        skippedCount++;
      } else {
        importedCount++;
      }
    }

    if (latestDate) {
      await this.conversationRepo.setLastActivityAt(conv.id, latestDate);
    }

    // Si la conversación no tiene caso activo ni mensajes recientes (<24h), cerrarla
    if (!conv.activeCaseId) {
      const isRecent =
        latestDate && Date.now() - latestDate.getTime() < 24 * 60 * 60 * 1000;
      if (!isRecent && conv.status === "open") {
        await this.conversationRepo.setStatus(conv.id, "closed");
      }
    }

    // Actualizar métricas acumuladas de mensajes
    const currentProgress = await this.getProgress();
    if (currentProgress && currentProgress.jobId === job.jobId) {
      currentProgress.totalMessagesImported += importedCount;
      currentProgress.totalMessagesSkipped += skippedCount;
      await this.saveProgress(currentProgress);
    }

    this.logger.info(
      {
        phone: job.participantId,
        importedCount,
        skippedCount,
        totalFetched: messages.length,
      },
      "Mensajes de conversacion sincronizados con exito",
    );
  }
}
