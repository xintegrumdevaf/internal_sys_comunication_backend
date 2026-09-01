import type {
  AgentPerformanceDto,
  AIEfficiencyDto,
  AnalyticsOverviewDto,
  CasesDistributionDto,
  InfrastructureAlertDto,
} from "../../domain/analytics.types";

export type AnalyticsFilter = {
  from: Date;
  to: Date;
  /** null = global (admin); array = restringido a los departamentos autorizados (manager). */
  departmentIds?: string[] | null;
};

export interface AnalyticsRepositoryPort {
  getOverview(filter: AnalyticsFilter): Promise<AnalyticsOverviewDto>;
  getCasesDistribution(filter: AnalyticsFilter): Promise<CasesDistributionDto>;
  getAIEfficiency(filter: AnalyticsFilter): Promise<AIEfficiencyDto>;
  getAgentsPerformance(
    filter: AnalyticsFilter,
    maxCapacityThreshold: number,
  ): Promise<AgentPerformanceDto[]>;
  getInfrastructureAlerts(filter: AnalyticsFilter): Promise<InfrastructureAlertDto[]>;
}
