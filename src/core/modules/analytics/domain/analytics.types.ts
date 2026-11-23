export type AnalyticsOverviewDto = {
  totalCases: number;
  activeCases: number;
  completedCases: number;
  botContainmentRate: number; // Porcentaje (0 - 100)
  avgResolutionTimeMinutes: number | null;
  avgQueueWaitTimeSeconds: number | null;
  escalationRate: number; // Porcentaje (0 - 100)
  escalatedCases?: number;
  unassignedCases?: number;
  unattendedCases?: number;
};

export type DepartmentDistributionItem = {
  departmentId: string;
  departmentName: string;
  count: number;
  percentage: number;
};

export type WorkflowDistributionItem = {
  workflowType: string;
  count: number;
  percentage: number;
};

export type FinalStatusDistributionItem = {
  status: string;
  count: number;
  percentage: number;
};

export type EscalationReasonItem = {
  reason: string;
  workflowType?: string;
  count: number;
  percentage: number;
};

export type HourlyDemandItem = {
  hour: number;
  label: string;
  count: number;
};

export type DailyTrendItem = {
  date: string;
  incoming: number;
  resolved: number;
};

export type CasesDistributionDto = {
  totalCases: number;
  byWorkflow: WorkflowDistributionItem[];
  byFinalStatus: FinalStatusDistributionItem[];
  topEscalationReasons: EscalationReasonItem[];
  byDepartment?: DepartmentDistributionItem[];
  hourlyDemand?: HourlyDemandItem[];
  dailyTrend?: DailyTrendItem[];
};

export type WorkflowDropOffItem = {
  workflowType: string;
  state: string;
  dropOffCount: number;
  percentage: number;
};

export type AIEfficiencyDto = {
  overallContainmentRate: number; // Porcentaje (0 - 100)
  botCompletedCases: number;
  humanEscalatedCases: number;
  funnelDropOff: WorkflowDropOffItem[];
  unclearTriageCount: number;
};

export type AgentPerformanceDto = {
  agentId: string;
  agentName: string;
  primaryDepartmentId: string | null;
  primaryDepartmentName: string | null;
  role: "agent" | "manager" | "admin";
  autoAssignEnabled: boolean;
  // Carga en caliente
  activeCasesNow: number;
  maxCapacityThreshold: number;
  // Volumen en el período (atribución multi-agente explícita)
  casesAssigned: number;
  casesTouched: number; // Casos distintos donde intervino (asignado, evento o mensaje enviado)
  casesCompleted: number; // Alias retrocompatible de casesResolved
  casesResolved: number; // Casos COMPLETED cerrados por este agente (suma exacto al área)
  casesTransferred: number; // Casos derivados/transferidos hacia otro asesor o área
  uniqueCustomersCount: number; // Clientes únicos tocados por este agente en el período
  lastCaseAt: string | null; // Última intervención/actividad en un caso dentro del período
  // Velocidad
  avgFirstResponseTimeMs: number | null;
  avgHandlingTimeMinutes: number | null;
  // Calidad y Efectividad
  fcrRatePercentage: number | null; // % sin reapertura en 48h
  avgCordialityScore: number | null; // 0 - 100
  criticalAlertsCount: number; // findings high
  openCoachingNotesCount: number; // notas no reconocidas
  // SLA y espera en vivo
  unattendedActiveCases?: number; // Casos asignados activos donde el cliente espera respuesta
  maxPendingWaitMinutes?: number | null; // El caso que lleva más minutos esperando respuesta humana
};

export type InfrastructureAlertDto = {
  sector: string;
  oltName: string | null;
  activeCasesCount: number;
  isHighVolumeAlert: boolean; // true si >= 3 casos activos en el mismo sector
};

export type DepartmentSummaryItemDto = {
  departmentId: string;
  departmentName: string;
  totalCases: number;
  activeCases: number;
  completedCases: number;
  botContainmentRate: number;
  escalationRate: number;
  unassignedCases: number;
  uniqueCustomersCount: number;
  totalAgentsCount: number;
  onShiftAgentsCount: number;
  maxCapacity: number;
  saturationPct: number;
};

export type AnalyticsCaseAttentionMode = "AI_ONLY" | "AI_AND_HUMAN" | "HUMAN_DIRECT";

export type AnalyticsParticipatingAgent = {
  agentId: string;
  agentName: string;
};

export type AnalyticsCaseItemDto = {
  caseId: string;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  status: string;
  workflowType: string;
  reason: string | null;
  departmentId: string | null;
  departmentName: string;
  customerKey: string;
  customerId: string | null;
  customerName: string;
  waPhone: string;
  nationalId: string | null;
  attentionMode: AnalyticsCaseAttentionMode;
  ownerAgentId: string | null;
  ownerAgentName: string | null;
  closedByAgentId: string | null;
  closedByAgentName: string | null;
  participatingAgents: AnalyticsParticipatingAgent[];
  handoffCount: number;
};

export type PaginatedAnalyticsCasesDto = {
  items: AnalyticsCaseItemDto[];
  total: number;
  page: number;
  pageSize: number;
};

export type AnalyticsCustomerAgentSummary = {
  agentId: string;
  agentName: string;
  casesCount: number;
};

export type AnalyticsCustomerCaseBrief = {
  caseId: string;
  conversationId: string;
  createdAt: string;
  status: string;
  workflowType: string;
  reason: string | null;
  departmentName: string;
  ownerAgentName: string | null;
  participatingAgents: string[];
};

export type AnalyticsCustomerItemDto = {
  customerKey: string;
  customerId: string | null;
  customerName: string;
  waPhone: string;
  nationalId: string | null;
  departmentNames: string[];
  totalCases: number;
  completedCases: number;
  activeCases: number;
  lastCaseAt: string;
  lastCaseStatus: string;
  lastCaseWorkflowType: string;
  lastCaseReason: string | null;
  lastConversationId: string;
  lastAgentId: string | null;
  lastAgentName: string | null;
  participatingAgents: AnalyticsCustomerAgentSummary[];
  distinctAgentsCount: number;
  recentCases: AnalyticsCustomerCaseBrief[];
};

export type PaginatedAnalyticsCustomersDto = {
  items: AnalyticsCustomerItemDto[];
  total: number;
  page: number;
  pageSize: number;
};

export type AnalyticsExportSection = "summary" | "agents" | "cases" | "customers";

export type AnalyticsExportEstimateDto = {
  totalCases: number;
  uniqueCustomers: number;
  agentsCount: number;
  departmentsCount: number;
  maxRowsPerSheet: number;
  exceedsLimit: boolean;
};
