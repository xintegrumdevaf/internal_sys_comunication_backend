import { Router } from "express";
import type { Pool } from "pg";
import { metricsRegistry, updatePostgresPoolMetrics } from "./metrics";

export type MetricsRouterDeps = {
  pgPool?: Pool;
};

/**
 * GET /metrics — Exposición estándar en formato Prometheus
 */
export function createMetricsRouter(deps: MetricsRouterDeps = {}): Router {
  const router = Router();

  router.get("/metrics", async (_req, res, next) => {
    try {
      if (deps.pgPool) {
        updatePostgresPoolMetrics(deps.pgPool);
      }
      res.set("Content-Type", metricsRegistry.contentType);
      const metricsData = await metricsRegistry.metrics();
      res.send(metricsData);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
