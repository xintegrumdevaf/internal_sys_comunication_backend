import type { Writable } from "node:stream";
import { validationError } from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { AnalyticsExportSection } from "../../domain/analytics.types";
import type { AnalyticsRepositoryPort } from "../ports/analytics.repository.port";
import { resolveAnalyticsDepartmentScope } from "../analytics-auth";
import {
  buildAnalyticsExcelFilename,
  streamAnalyticsExcelWorkbook,
} from "../../infrastructure/export/analytics-excel-stream.builder";
import { DEFAULT_MAX_EXPORT_ROWS_PER_SHEET } from "./get-analytics-export-estimate.use-case";

const VALID_SECTIONS: ReadonlySet<AnalyticsExportSection> = new Set([
  "summary",
  "agents",
  "cases",
  "customers",
]);

const MAX_DETAILED_RANGE_DAYS = 92;

export class ExportAnalyticsExcelUseCase {
  constructor(
    private readonly deps: {
      analyticsRepo: AnalyticsRepositoryPort;
      agentRepo: AgentRepositoryPort;
      departmentRepo?: DepartmentRepositoryPort;
      maxCapacityThreshold: number;
      maxRowsPerSheet?: number;
    },
  ) {}

  async prepare(input: {
    actor: Agent;
    from: Date;
    to: Date;
    departmentId?: string;
    agentId?: string;
    sections: AnalyticsExportSection[];
  }): Promise<{
    filename: string;
    areaLabel: string;
    departmentIds: string[] | null;
    sections: Set<AnalyticsExportSection>;
  }> {
    const uniqueSections = new Set<AnalyticsExportSection>(
      input.sections.filter((s): s is AnalyticsExportSection => VALID_SECTIONS.has(s)),
    );
    if (uniqueSections.size === 0) {
      throw validationError("Debe seleccionar al menos una sección válida para exportar");
    }

    const departmentIds = await resolveAnalyticsDepartmentScope(
      input.actor,
      this.deps.agentRepo,
      input.departmentId,
    );

    const includesHeavySection = uniqueSections.has("cases") || uniqueSections.has("customers");
    const rangeDays = (input.to.getTime() - input.from.getTime()) / (1000 * 60 * 60 * 24);
    if (includesHeavySection && rangeDays > MAX_DETAILED_RANGE_DAYS) {
      throw validationError(
        `Para exportar Casos o Clientes el rango máximo permitido es de ${MAX_DETAILED_RANGE_DAYS} días.`,
      );
    }

    let areaLabel = "Toda la empresa (Global)";
    const singleScopedDeptId = departmentIds && departmentIds.length === 1 ? departmentIds[0] : undefined;
    if (input.departmentId && this.deps.departmentRepo) {
      const dept = await this.deps.departmentRepo.findById(input.departmentId);
      if (dept) areaLabel = dept.name;
    } else if (singleScopedDeptId && this.deps.departmentRepo) {
      const dept = await this.deps.departmentRepo.findById(singleScopedDeptId);
      if (dept) areaLabel = dept.name;
    } else if (departmentIds && departmentIds.length > 1) {
      areaLabel = "Mis Departamentos";
    }

    return {
      filename: buildAnalyticsExcelFilename(areaLabel),
      areaLabel,
      departmentIds,
      sections: uniqueSections,
    };
  }

  async writeToStream(params: {
    stream: Writable;
    from: Date;
    to: Date;
    departmentIds: string[] | null;
    agentId?: string;
    areaLabel: string;
    sections: Set<AnalyticsExportSection>;
  }): Promise<void> {
    const filter = {
      from: params.from,
      to: params.to,
      departmentIds: params.departmentIds,
    };
    const maxRowsPerSheet = this.deps.maxRowsPerSheet ?? DEFAULT_MAX_EXPORT_ROWS_PER_SHEET;

    await streamAnalyticsExcelWorkbook({
      stream: params.stream,
      sections: params.sections,
      areaLabel: params.areaLabel,
      scopedDepartmentIds: params.departmentIds,
      from: params.from,
      to: params.to,
      maxRowsPerSheet,
      loadSummaryData: async () => {
        const [overview, distribution, aiEfficiency, departmentsSummary] = await Promise.all([
          this.deps.analyticsRepo.getOverview(filter),
          this.deps.analyticsRepo.getCasesDistribution(filter),
          this.deps.analyticsRepo.getAIEfficiency(filter),
          this.deps.analyticsRepo.getDepartmentsSummary(filter, this.deps.maxCapacityThreshold),
        ]);
        return { overview, distribution, aiEfficiency, departmentsSummary };
      },
      loadAgentsData: async () => {
        const agents = await this.deps.analyticsRepo.getAgentsPerformance(
          filter,
          this.deps.maxCapacityThreshold,
        );
        return params.agentId
          ? agents.filter((a) => a.agentId === params.agentId)
          : agents;
      },
      fetchCasesPage: (page, pageSize) =>
        this.deps.analyticsRepo.listAttendedCases({
          ...filter,
          agentId: params.agentId,
          page,
          pageSize,
        }),
      fetchCustomersPage: (page, pageSize) =>
        this.deps.analyticsRepo.listAttendedCustomers({
          ...filter,
          agentId: params.agentId,
          page,
          pageSize,
        }),
    });
  }
}
