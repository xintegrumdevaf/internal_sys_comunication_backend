import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createAnalyticsRouter } from "../../../src/core/modules/analytics/presentation/analytics.router";
import { GetAnalyticsOverviewUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-analytics-overview.use-case";
import { GetCasesDistributionUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-cases-distribution.use-case";
import { GetAIEfficiencyUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-ai-efficiency.use-case";
import { GetAgentsPerformanceUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-agents-performance.use-case";
import { GetInfrastructureAlertsUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-infrastructure-alerts.use-case";
import { AgentRepositoryFake } from "../../support/agent-audit.fakes";
import type { AnalyticsRepositoryPort, AnalyticsFilter } from "../../../src/core/modules/analytics/application/ports/analytics.repository.port";
import type { Agent } from "../../../src/core/modules/departments/domain/agent.entity";
import { createErrorHandler } from "../../../src/shared/http/middlewares/error-handler.middleware";
import { silentLogger } from "../../support/silent-logger";

class AnalyticsRepoStub implements AnalyticsRepositoryPort {
  async getOverview(_filter: AnalyticsFilter) {
    return {
      totalCases: 50,
      activeCases: 10,
      completedCases: 40,
      botContainmentRate: 70,
      avgResolutionTimeMinutes: 12.5,
      avgQueueWaitTimeSeconds: 30,
      escalationRate: 30,
    };
  }

  async getCasesDistribution(_filter: AnalyticsFilter) {
    return {
      totalCases: 50,
      byWorkflow: [{ workflowType: "SUPPORT_INTERNET", count: 50, percentage: 100 }],
      byFinalStatus: [{ status: "COMPLETED", count: 40, percentage: 80 }],
      topEscalationReasons: [{ reason: "REQUEST_HUMAN", count: 10, percentage: 100 }],
    };
  }

  async getAIEfficiency(_filter: AnalyticsFilter) {
    return {
      overallContainmentRate: 70,
      botCompletedCases: 35,
      humanEscalatedCases: 15,
      funnelDropOff: [],
      unclearTriageCount: 2,
    };
  }

  async getAgentsPerformance(_filter: AnalyticsFilter, _maxCapacityThreshold: number) {
    return [
      {
        agentId: "ag-1",
        agentName: "Juan Perez",
        primaryDepartmentId: "dept-support",
        primaryDepartmentName: "Soporte",
        role: "agent" as const,
        autoAssignEnabled: true,
        activeCasesNow: 2,
        maxCapacityThreshold: 6,
        casesAssigned: 15,
        casesCompleted: 14,
        casesTransferred: 1,
        avgFirstResponseTimeMs: 90000,
        avgHandlingTimeMinutes: 15.2,
        fcrRatePercentage: 92.5,
        avgCordialityScore: 85,
        criticalAlertsCount: 0,
        openCoachingNotesCount: 0,
      },
    ];
  }

  async getInfrastructureAlerts(_filter: AnalyticsFilter) {
    return [
      {
        sector: "Sector Sur",
        oltName: "OLT-01",
        activeCasesCount: 4,
        isHighVolumeAlert: true,
      },
    ];
  }
}

function createTestApp(currentAgent: Agent | null) {
  const app = express();
  app.use(express.json());

  // Middleware simulador de sesión
  app.use((req, _res, next) => {
    if (currentAgent) {
      req.agent = currentAgent;
    }
    next();
  });

  const agentRepo = new AgentRepositoryFake();
  const analyticsRepo = new AnalyticsRepoStub();

  const router = createAnalyticsRouter({
    getOverview: new GetAnalyticsOverviewUseCase({ analyticsRepo, agentRepo }),
    getCasesDistribution: new GetCasesDistributionUseCase({ analyticsRepo, agentRepo }),
    getAIEfficiency: new GetAIEfficiencyUseCase({ analyticsRepo, agentRepo }),
    getAgentsPerformance: new GetAgentsPerformanceUseCase({
      analyticsRepo,
      agentRepo,
      maxCapacityThreshold: 6,
    }),
    getInfrastructureAlerts: new GetInfrastructureAlertsUseCase({ analyticsRepo, agentRepo }),
  });

  app.use(router);
  app.use(createErrorHandler(silentLogger));
  return app;
}

describe("Analytics Router Endpoints (GET /api/analytics/*)", () => {
  const adminAgent: Agent = {
    id: "admin-1",
    name: "Admin User",
    email: "admin@isp.local",
    role: "admin",
    primaryDepartmentId: "dept-support",
    active: true,
    autoAssignEnabled: false,
    mustChangePassword: false,
    passwordHash: null,
    createdAt: new Date(),
  };

  const normalAgent: Agent = {
    id: "agent-1",
    name: "Regular Agent",
    email: "agent@isp.local",
    role: "agent",
    primaryDepartmentId: "dept-support",
    active: true,
    autoAssignEnabled: true,
    mustChangePassword: false,
    passwordHash: null,
    createdAt: new Date(),
  };

  it("rechaza peticiones sin autenticación (403)", async () => {
    const app = createTestApp(null);
    const res = await request(app).get("/api/analytics/overview");
    expect(res.status).toBe(403);
  });

  it("rechaza usuarios con rol 'agent' (403)", async () => {
    const app = createTestApp(normalAgent);
    const res = await request(app).get("/api/analytics/overview");
    expect(res.status).toBe(403);
  });

  it("GET /api/analytics/overview devuelve KPIs con 200 para admin", async () => {
    const app = createTestApp(adminAgent);
    const res = await request(app).get("/api/analytics/overview");
    expect(res.status).toBe(200);
    expect(res.body.data.totalCases).toBe(50);
    expect(res.body.data.botContainmentRate).toBe(70);
  });

  it("GET /api/analytics/cases-distribution devuelve desglose con 200", async () => {
    const app = createTestApp(adminAgent);
    const res = await request(app).get("/api/analytics/cases-distribution");
    expect(res.status).toBe(200);
    expect(res.body.data.byWorkflow).toHaveLength(1);
    expect(res.body.data.byFinalStatus).toHaveLength(1);
  });

  it("GET /api/analytics/ai-efficiency devuelve métricas de IA con 200", async () => {
    const app = createTestApp(adminAgent);
    const res = await request(app).get("/api/analytics/ai-efficiency");
    expect(res.status).toBe(200);
    expect(res.body.data.overallContainmentRate).toBe(70);
    expect(res.body.data.botCompletedCases).toBe(35);
  });

  it("GET /api/analytics/agents-performance devuelve métricas de agentes con 200", async () => {
    const app = createTestApp(adminAgent);
    const res = await request(app).get("/api/analytics/agents-performance");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].agentName).toBe("Juan Perez");
    expect(res.body.data[0].fcrRatePercentage).toBe(92.5);
    expect(res.body.data[0].activeCasesNow).toBe(2);
  });

  it("GET /api/analytics/infrastructure-alerts devuelve alertas de red con 200", async () => {
    const app = createTestApp(adminAgent);
    const res = await request(app).get("/api/analytics/infrastructure-alerts");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sector).toBe("Sector Sur");
    expect(res.body.data[0].isHighVolumeAlert).toBe(true);
  });
});
