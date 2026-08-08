import { Router } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import { checkPostgresConnection } from "../db/pool";
import { checkRedisConnection } from "../queue/redis";

export type HealthRouterDeps = {
  pgPool: Pool;
  redisClient: Redis;
};

/**
 * GET /health — criterio de aceptacion de la Etapa 0 (05_BUILD_PLAN.md).
 * No es logica de negocio: solo reporta si las dependencias externas
 * (Postgres, Redis) estan alcanzables desde el proceso de la API.
 */
export function createHealthRouter({ pgPool, redisClient }: HealthRouterDeps): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const [postgresUp, redisUp] = await Promise.all([
      checkPostgresConnection(pgPool),
      checkRedisConnection(redisClient),
    ]);

    const healthy = postgresUp && redisUp;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      dependencies: {
        postgres: postgresUp ? "up" : "down",
        redis: redisUp ? "up" : "down",
      },
    });
  });

  return router;
}
