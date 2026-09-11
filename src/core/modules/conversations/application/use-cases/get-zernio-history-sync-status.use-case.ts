import type Redis from "ioredis";
import type { ZernioSyncProgress } from "../../domain/zernio-history.types";
import { ZERNIO_HISTORY_STATUS_KEY } from "../../infrastructure/queue/zernio-history-sync.worker";

export type ZernioSyncStatusResponse = ZernioSyncProgress & {
  percentage: number;
};

export class GetZernioHistorySyncStatusUseCase {
  constructor(private readonly redisClient: Redis | null) {}

  async execute(): Promise<ZernioSyncStatusResponse> {
    if (!this.redisClient) {
      return {
        jobId: "no-redis",
        status: "IDLE",
        totalConversations: 0,
        processedConversations: 0,
        failedConversations: 0,
        totalMessagesImported: 0,
        totalMessagesSkipped: 0,
        currentPhone: null,
        startedAt: null,
        finishedAt: null,
        errors: [],
        percentage: 0,
      };
    }

    const raw = await this.redisClient.get(ZERNIO_HISTORY_STATUS_KEY);
    if (!raw) {
      return {
        jobId: "none",
        status: "IDLE",
        totalConversations: 0,
        processedConversations: 0,
        failedConversations: 0,
        totalMessagesImported: 0,
        totalMessagesSkipped: 0,
        currentPhone: null,
        startedAt: null,
        finishedAt: null,
        errors: [],
        percentage: 0,
      };
    }

    const progress = JSON.parse(raw) as ZernioSyncProgress;
    const completed = progress.processedConversations + progress.failedConversations;
    const percentage =
      progress.totalConversations > 0
        ? Math.min(100, Math.round((completed / progress.totalConversations) * 100))
        : progress.status === "COMPLETED"
          ? 100
          : 0;

    return {
      ...progress,
      percentage,
    };
  }
}


