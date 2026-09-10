import type { Request, Response, NextFunction } from "express";
import { httpRequestDurationSeconds, httpRequestsTotal } from "./metrics";

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMERIC_ID_REGEX = /\/\d+(\/|$)/g;

/**
 * Normaliza la ruta URL para evitar explosión de cardinalidad en Prometheus
 * (ej. /api/conversations/123e4567-e89b... -> /api/conversations/:id)
 */
export function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  return path
    .replace(UUID_REGEX, ":id")
    .replace(NUMERIC_ID_REGEX, "/:id$1")
    .split("?")[0]!;
}

export function createMetricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // No medir llamadas al propio endpoint de métricas
    if (req.path === "/metrics") {
      next();
      return;
    }

    const start = process.hrtime();

    res.on("finish", () => {
      const diff = process.hrtime(start);
      const durationSeconds = diff[0] + diff[1] / 1e9;
      const route = normalizePath(req.route?.path ? `${req.baseUrl || ""}${req.route.path}` : req.path);
      const labels = {
        method: req.method,
        route,
        status_code: res.statusCode.toString(),
      };

      httpRequestsTotal.inc(labels);
      httpRequestDurationSeconds.observe(labels, durationSeconds);
    });

    next();
  };
}
