export type AnalyticsOverviewDto = {
  totalCases: number;
  activeCases: number;
  completedCases: number;
  botContainmentRate: number; // Porcentaje (0 - 100)
  avgResolutionTimeMinutes: number | null;
  avgQueueWaitTimeSeconds: number | null;
  escalationRate: number; // Porcentaje (0 - 100)
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
  count: number;
  percentage: number;
};

export type CasesDistributionDto = {
  totalCases: number;
  byWorkflow: WorkflowDistributionItem[];
  byFinalStatus: FinalStatusDistributionItem[];
  topEscalationReasons: EscalationReasonItem[];
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
  // Volumen en el período
  casesAssigned: number;
  casesCompleted: number;
  casesTransferred: number;
  // Velocidad
  avgFirstResponseTimeMs: number | null;
  avgHandlingTimeMinutes: number | null;
  // Calidad y Efectividad
  fcrRatePercentage: number | null; // % sin reapertura en 48h
  avgCordialityScore: number | null; // 0 - 100
  criticalAlertsCount: number; // findings high
  openCoachingNotesCount: number; // notas no reconocidas
};

export type InfrastructureAlertDto = {
  sector: string;
  oltName: string | null;
  activeCasesCount: number;
  isHighVolumeAlert: boolean; // true si >= 3 casos activos en el mismo sector
};
