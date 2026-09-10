import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from "prom-client";
import type { Pool } from "pg";

export const metricsRegistry = new Registry();

// Prefijo estándar para todas las métricas de la aplicación
metricsRegistry.setDefaultLabels({
  app: "isp_communication_backend",
});

// 1. Recolector de métricas del sistema y Node.js runtime (Event Loop, Memoria Heap/RSS, CPU, GC)
collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "isp_node_",
});

// 2. Contador total de peticiones HTTP
export const httpRequestsTotal = new Counter({
  name: "isp_http_requests_total",
  help: "Total de peticiones HTTP procesadas",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

// 3. Histograma de latencia de peticiones HTTP
export const httpRequestDurationSeconds = new Histogram({
  name: "isp_http_request_duration_seconds",
  help: "Duración de peticiones HTTP en segundos",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

// 4. Gauge del pool de PostgreSQL
export const pgPoolConnectionsGauge = new Gauge({
  name: "isp_pg_pool_connections",
  help: "Estado del pool de conexiones PostgreSQL",
  labelNames: ["state"],
  registers: [metricsRegistry],
});

// 5. Histograma de llamadas a IA (Ollama / Qwen)
export const aiInferenceDurationSeconds = new Histogram({
  name: "isp_ai_inference_duration_seconds",
  help: "Duración de inferencias y llamadas a IA en segundos",
  labelNames: ["operation", "status"],
  buckets: [0.2, 0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

// 6. Conexiones SSE en tiempo real
export const sseActiveClientsGauge = new Gauge({
  name: "isp_sse_active_clients",
  help: "Número de clientes conectados a eventos en tiempo real (SSE)",
  registers: [metricsRegistry],
});

/**
 * Actualiza métricas del pool de Postgres antes de que Prometheus las consulte
 */
export function updatePostgresPoolMetrics(pool: Pool): void {
  pgPoolConnectionsGauge.set({ state: "total" }, pool.totalCount);
  pgPoolConnectionsGauge.set({ state: "idle" }, pool.idleCount);
  pgPoolConnectionsGauge.set({ state: "waiting" }, pool.waitingCount);
}
