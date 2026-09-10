import { Router } from "express";
import { requireRole } from "../../../../shared/http/require-auth";
import type { StartZernioHistorySyncUseCase } from "../application/use-cases/start-zernio-history-sync.use-case";
import type { GetZernioHistorySyncStatusUseCase } from "../application/use-cases/get-zernio-history-sync-status.use-case";

export interface ZernioHistorySyncRouterDeps {
  startSync: StartZernioHistorySyncUseCase;
  getStatus: GetZernioHistorySyncStatusUseCase;
}

export function createZernioHistorySyncRouter(deps: ZernioHistorySyncRouterDeps): Router {
  const router = Router();
  const { startSync, getStatus } = deps;

  router.post("/api/admin/conversations/sync-zernio-history", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      const result = await startSync.execute();
      res.status(result.alreadyRunning ? 200 : 202).json({
        data: result.progress,
        message: result.alreadyRunning
          ? "La sincronizacion ya se encuentra en progreso"
          : "Sincronizacion iniciada en cola en segundo plano",
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/admin/conversations/sync-zernio-history/status", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      const status = await getStatus.execute();
      res.json({ data: status });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
