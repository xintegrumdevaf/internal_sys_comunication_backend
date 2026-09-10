import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createMetricsMiddleware } from "../../src/shared/monitoring/metrics.middleware";
import { createMetricsRouter } from "../../src/shared/monitoring/metrics.router";

describe("Prometheus Metrics Integration", () => {
  it("GET /metrics expone métricas estándar de Prometheus y métricas de la aplicación", async () => {
    const app = express();
    app.use(createMetricsMiddleware());
    app.use(createMetricsRouter());

    app.get("/api/test-endpoint", (_req, res) => {
      res.json({ ok: true });
    });

    // Hacemos una llamada para registrar métricas
    await request(app).get("/api/test-endpoint").expect(200);

    const res = await request(app).get("/metrics").expect(200);

    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("isp_node_");
    expect(res.text).toContain("isp_http_requests_total");
    expect(res.text).toContain("isp_http_request_duration_seconds");
    expect(res.text).toContain("route=\"/api/test-endpoint\"");
  });
});
