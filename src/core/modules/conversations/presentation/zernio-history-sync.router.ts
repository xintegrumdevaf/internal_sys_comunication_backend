import { Router } from "express";
import { requireRole } from "../../../../shared/http/require-auth";
import type { StartZernioHistorySyncUseCase } from "../application/use-cases/start-zernio-history-sync.use-case";
import type { GetZernioHistorySyncStatusUseCase } from "../application/use-cases/get-zernio-history-sync-status.use-case";
import type { ZernioSyncProgress } from "../domain/zernio-history.types";

export interface ZernioHistorySyncRouterDeps {
  startSync: StartZernioHistorySyncUseCase;
  getStatus: GetZernioHistorySyncStatusUseCase;
}

function formatClientProgress(progress: ZernioSyncProgress & { percentage?: number }) {
  let mappedStatus: "idle" | "running" | "completed" | "failed" = "idle";
  if (progress.status === "IN_PROGRESS") {
    mappedStatus = "running";
  } else if (progress.status === "COMPLETED") {
    mappedStatus = "completed";
  } else if (progress.status === "PARTIALLY_FAILED") {
    mappedStatus = "failed";
  }

  const completed = progress.processedConversations + progress.failedConversations;
  const calculatedPercentage =
    progress.totalConversations > 0
      ? Math.min(100, Math.round((completed / progress.totalConversations) * 100))
      : progress.status === "COMPLETED"
        ? 100
        : 0;

  const lastErr =
    progress.errors && progress.errors.length > 0
      ? (progress.errors[progress.errors.length - 1]?.error ?? null)
      : null;

  return {
    ...progress,
    status: mappedStatus,
    rawStatus: progress.status,
    totalMessagesSynced: progress.totalMessagesImported,
    completedAt: progress.finishedAt,
    lastError: lastErr,
    progress: progress.percentage ?? calculatedPercentage,
    totalItems: progress.totalConversations,
  };
}

export function createZernioHistorySyncRouter(deps: ZernioHistorySyncRouterDeps): Router {
  const router = Router();
  const { startSync, getStatus } = deps;

  router.post(
    ["/api/admin/conversations/sync-zernio-history", "/api/conversations/sync-history"],
    async (req, res, next) => {
      try {
        requireRole(req, ["admin"]);
        const result = await startSync.execute();
        res.status(result.alreadyRunning ? 200 : 202).json({
          data: formatClientProgress(result.progress),
          message: result.alreadyRunning
            ? "La sincronizacion ya se encuentra en progreso"
            : "Sincronizacion iniciada en cola en segundo plano",
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    [
      "/api/admin/conversations/sync-zernio-history/status",
      "/api/conversations/sync-history/status",
    ],
    async (req, res, next) => {
      try {
        requireRole(req, ["admin", "manager"]);
        const status = await getStatus.execute();
        res.json({ data: formatClientProgress(status) });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

