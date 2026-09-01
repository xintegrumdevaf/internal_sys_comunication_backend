import { describe, expect, it } from "vitest";
import type { AnalyticsRepositoryPort, AnalyticsFilter } from "../../../src/core/modules/analytics/application/ports/analytics.repository.port";
import type {
  AgentPerformanceDto,
  AIEfficiencyDto,
  AnalyticsOverviewDto,
  CasesDistributionDto,
  InfrastructureAlertDto,
} from "../../../src/core/modules/analytics/domain/analytics.types";
import { GetAnalyticsOverviewUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-analytics-overview.use-case";
import { GetCasesDistributionUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-cases-distribution.use-case";
import { GetAIEfficiencyUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-ai-efficiency.use-case";
import { GetAgentsPerformanceUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-agents-performance.use-case";
import { GetInfrastructureAlertsUseCase } from "../../../src/core/modules/analytics/application/use-cases/get-infrastructure-alerts.use-case";
import { AgentRepositoryFake } from "../../support/agent-audit.fakes";
import type { Agent } from "../../../src/core/modules/departments/domain/agent.entity";

class AnalyticsRepositoryFake implements AnalyticsRepositoryPort {
  overviewData: AnalyticsOverviewDto = {
    totalCases: 100,
    activeCases: 15,
    completedCases: 80,
    botContainmentRate: 62.5,
    avgResolutionTimeMinutes: 14.2,
    avgQueueWaitTimeSeconds: 45,
    escalationRate: 37.5,
  };

  distributionData: CasesDistributionDto = {
    totalCases: 100,
    byWorkflow: [
      { workflowType: "SUPPORT_INTERNET", count: 65, percentage: 65 },
      { workflowType: "BILLING_BALANCE", count: 35, percentage: 35 },
    ],
    byFinalStatus: [
      { status: "COMPLETED", count: 80, percentage: 80 },
      { status: "EXPIRED", count: 12, percentage: 12 },
      { status: "CANCELLED", count: 8, percentage: 8 },
    ],
    topEscalationReasons: [
      { reason: "REQUEST_HUMAN", count: 25, percentage: 66.7 },
      { reason: "TECHNICAL_FAULT", count: 10, percentage: 26.7 },
    ],
  };

  aiEfficiencyData: AIEfficiencyDto = {
    overallContainmentRate: 62.5,
    botCompletedCases: 50,
    humanEscalatedCases: 30,
    funnelDropOff: [
      { workflowType: "SUPPORT_INTERNET", state: "WAITING_USER", dropOffCount: 15, percentage: 50 },
    ],
    unclearTriageCount: 5,
  };

  agentsPerformanceData: AgentPerformanceDto[] = [
    {
      agentId: "ag-1",
      agentName: "Carlos Agente",
      primaryDepartmentId: "dept-support",
      primaryDepartmentName: "Soporte",
      role: "agent",
      autoAssignEnabled: true,
      activeCasesNow: 3,
      maxCapacityThreshold: 6,
      casesAssigned: 30,
      casesCompleted: 28,
      casesTransferred: 2,
      avgFirstResponseTimeMs: 120000, // 2 min
      avgHandlingTimeMinutes: 18.5,
      fcrRatePercentage: 89.3,
      avgCordialityScore: 88,
      criticalAlertsCount: 0,
      openCoachingNotesCount: 0,
    },
  ];

  infrastructureAlertsData: InfrastructureAlertDto[] = [
    {
      sector: "Sector Norte - Fibra 3",
      oltName: "OLT-HUAWEI-01",
      activeCasesCount: 5,
      isHighVolumeAlert: true,
    },
    {
      sector: "Sector Centro",
      oltName: "OLT-VSOL-02",
      activeCasesCount: 1,
      isHighVolumeAlert: false,
    },
  ];

  lastFilter?: AnalyticsFilter;
  lastThreshold?: number;

  async getOverview(filter: AnalyticsFilter): Promise<AnalyticsOverviewDto> {
    this.lastFilter = filter;
    return this.overviewData;
  }

  async getCasesDistribution(filter: AnalyticsFilter): Promise<CasesDistributionDto> {
    this.lastFilter = filter;
    return this.distributionData;
  }

  async getAIEfficiency(filter: AnalyticsFilter): Promise<AIEfficiencyDto> {
    this.lastFilter = filter;
    return this.aiEfficiencyData;
  }

  async getAgentsPerformance(
    filter: AnalyticsFilter,
    maxCapacityThreshold: number,
  ): Promise<AgentPerformanceDto[]> {
    this.lastFilter = filter;
    this.lastThreshold = maxCapacityThreshold;
    return this.agentsPerformanceData;
  }

  async getInfrastructureAlerts(filter: AnalyticsFilter): Promise<InfrastructureAlertDto[]> {
    this.lastFilter = filter;
    return this.infrastructureAlertsData;
  }
}

describe("Analytics Use Cases", () => {
  const agentRepo = new AgentRepositoryFake();
  const analyticsRepo = new AnalyticsRepositoryFake();

  const admin: Agent = {
    id: "admin-1",
    name: "Admin",
    email: "admin@isp.local",
    role: "admin",
    primaryDepartmentId: "dept-support",
    active: true,
    autoAssignEnabled: false,
    mustChangePassword: false,
    passwordHash: null,
    createdAt: new Date(),
  };

  const from = new Date("2026-08-01T00:00:00Z");
  const to = new Date("2026-08-31T23:59:59Z");

  it("GetAnalyticsOverviewUseCase ejecuta correctamente y devuelve KPIs macro", async () => {
    const useCase = new GetAnalyticsOverviewUseCase({ analyticsRepo, agentRepo });
    const result = await useCase.execute({ actor: admin, from, to });

    expect(result.totalCases).toBe(100);
    expect(result.botContainmentRate).toBe(62.5);
    expect(analyticsRepo.lastFilter?.from).toEqual(from);
    expect(analyticsRepo.lastFilter?.to).toEqual(to);
    expect(analyticsRepo.lastFilter?.departmentIds).toBeNull();
  });

  it("GetCasesDistributionUseCase devuelve desglose por workflow, estado y motivos", async () => {
    const useCase = new GetCasesDistributionUseCase({ analyticsRepo, agentRepo });
    const result = await useCase.execute({ actor: admin, from, to });

    expect(result.byWorkflow).toHaveLength(2);
    expect(result.byFinalStatus).toHaveLength(3);
    expect(result.topEscalationReasons[0]?.reason).toBe("REQUEST_HUMAN");
  });

  it("GetAIEfficiencyUseCase devuelve contención, casos bot y drop-off", async () => {
    const useCase = new GetAIEfficiencyUseCase({ analyticsRepo, agentRepo });
    const result = await useCase.execute({ actor: admin, from, to });

    expect(result.overallContainmentRate).toBe(62.5);
    expect(result.botCompletedCases).toBe(50);
    expect(result.funnelDropOff[0]?.state).toBe("WAITING_USER");
  });

  it("GetAgentsPerformanceUseCase pasa el threshold de capacidad y devuelve métricas completas", async () => {
    const useCase = new GetAgentsPerformanceUseCase({
      analyticsRepo,
      agentRepo,
      maxCapacityThreshold: 6,
    });
    const result = await useCase.execute({ actor: admin, from, to });

    expect(result).toHaveLength(1);
    expect(result[0]?.agentName).toBe("Carlos Agente");
    expect(result[0]?.fcrRatePercentage).toBe(89.3);
    expect(result[0]?.maxCapacityThreshold).toBe(6);
    expect(result[0]?.activeCasesNow).toBe(3);
    expect(analyticsRepo.lastThreshold).toBe(6);
  });

  it("GetInfrastructureAlertsUseCase clasifica caídas masivas en sectores", async () => {
    const useCase = new GetInfrastructureAlertsUseCase({ analyticsRepo, agentRepo });
    const result = await useCase.execute({ actor: admin, from, to });

    expect(result).toHaveLength(2);
    expect(result[0]?.sector).toBe("Sector Norte - Fibra 3");
    expect(result[0]?.isHighVolumeAlert).toBe(true);
    expect(result[1]?.isHighVolumeAlert).toBe(false);
  });
});
