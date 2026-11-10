import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createTelegramSnapshotRouter } from "../../src/core/modules/telegram/presentation/telegram-snapshot.router";
import { silentLogger } from "../support/silent-logger";

describe("TelegramSnapshotRouter (GET /analitica)", () => {
  const fakeOverview = {
    totalCases: 50,
    activeCases: 10,
    completedCases: 40,
    botContainmentRate: 70,
    avgResolutionTimeMinutes: 15.5,
    avgQueueWaitTimeSeconds: 45,
    escalationRate: 30,
  };

  const fakeDashboard = {
    myAssignedCases: 10,
    escalatedPending: 2,
    waitingUser: 3,
    departmentBreakdown: [
      {
        departmentId: "d1",
        departmentName: "Soporte Técnico",
        activeCases: 7,
        queueCases: 2,
      },
    ],
  };

  const fakeAnalyticsRepo = {
    getOverview: vi.fn().mockResolvedValue(fakeOverview),
  } as any;

  const fakeCaseRepo = {
    getDashboardMetrics: vi.fn().mockResolvedValue(fakeDashboard),
  } as any;

  const fakeAgentRepo = {
    list: vi.fn().mockResolvedValue([
      { id: "a1", name: "Agent 1", active: true, autoAssignEnabled: true },
    ]),
  } as any;

  const fakeSettingsService = {
    getTelegramSettings: vi.fn().mockResolvedValue({
      timeZone: "America/Guayaquil",
    }),
  } as any;

  const app = express();
  app.use(
    createTelegramSnapshotRouter({
      analyticsRepo: fakeAnalyticsRepo,
      caseRepo: fakeCaseRepo,
      agentRepo: fakeAgentRepo,
      settingsService: fakeSettingsService,
      logger: silentLogger,
      appPublicUrl: "https://isp.ngrok.app",
      frontendUrl: "http://localhost:5173",
    }),
  );

  it("GET /analitica devuelve un HTML responsivo y estilizado para dispositivos móviles", async () => {
    const res = await request(app).get("/analitica");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Snapshot Operativo Ejecutivo");
    expect(res.text).toContain("Centinela ISP");
    expect(res.text).toContain("50"); // total cases
    expect(res.text).toContain("70%"); // contención IA
    expect(res.text).toContain("Soporte Técnico");
  });

  it("GET /analitica con format=json o Accept application/json devuelve los datos estructurados", async () => {
    const res = await request(app)
      .get("/analitica?format=json")
      .set("Accept", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.overview.totalCases).toBe(50);
    expect(res.body.data.activeAgentsCount).toBe(1);
  });

  it("GET /bandeja redirige al frontend de bandeja o a la analítica", async () => {
    const res = await request(app).get("/bandeja");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://localhost:5173/bandeja");
  });
});
