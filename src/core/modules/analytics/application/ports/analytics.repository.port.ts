import type {
  AgentPerformanceDto,
  AIEfficiencyDto,
  AnalyticsCaseAttentionMode,
  AnalyticsExportEstimateDto,
  AnalyticsOverviewDto,
  CasesDistributionDto,
  DepartmentSummaryItemDto,
  InfrastructureAlertDto,
  PaginatedAnalyticsCasesDto,
  PaginatedAnalyticsCustomersDto,
} from "../../domain/analytics.types";

export type AnalyticsFilter = {
  from: Date;
  to: Date;
  /** null = global (admin); array = restringido a los departamentos autorizados (manager). */
  departmentIds?: string[] | null;
};

export type AnalyticsCasesQueryFilter = AnalyticsFilter & {
  agentId?: string;
  status?: string;
  attentionMode?: AnalyticsCaseAttentionMode;
  search?: string;
  page: number;
  pageSize: number;
};

export type AnalyticsCustomersQueryFilter = AnalyticsFilter & {
  agentId?: string;
  search?: string;
  page: number;
  pageSize: number;
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
  getDepartmentsSummary(
    filter: AnalyticsFilter,
    maxCapacityThreshold: number,
  ): Promise<DepartmentSummaryItemDto[]>;
  listAttendedCases(filter: AnalyticsCasesQueryFilter): Promise<PaginatedAnalyticsCasesDto>;
  listAttendedCustomers(
    filter: AnalyticsCustomersQueryFilter,
  ): Promise<PaginatedAnalyticsCustomersDto>;
  getExportEstimate(
    filter: AnalyticsFilter & { agentId?: string },
    maxRowsPerSheet: number,
  ): Promise<AnalyticsExportEstimateDto>;
}
