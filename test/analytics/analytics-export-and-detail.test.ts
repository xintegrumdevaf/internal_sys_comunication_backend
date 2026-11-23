import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import type {
  AnalyticsCasesQueryFilter,
  AnalyticsCustomersQueryFilter,
  AnalyticsFilter,
  AnalyticsRepositoryPort,
} from "../../src/core/modules/analytics/application/ports/analytics.repository.port";
import type {
  AgentPerformanceDto,
  AIEfficiencyDto,
  AnalyticsCaseItemDto,
  AnalyticsCustomerItemDto,
  AnalyticsOverviewDto,
  CasesDistributionDto,
  DepartmentSummaryItemDto,
} from "../../src/core/modules/analytics/domain/analytics.types";
import { GetDepartmentsSummaryUseCase } from "../../src/core/modules/analytics/application/use-cases/get-departments-summary.use-case";
import { ListAnalyticsCasesUseCase } from "../../src/core/modules/analytics/application/use-cases/list-analytics-cases.use-case";
import { ListAnalyticsCustomersUseCase } from "../../src/core/modules/analytics/application/use-cases/list-analytics-customers.use-case";
import { GetAnalyticsExportEstimateUseCase } from "../../src/core/modules/analytics/application/use-cases/get-analytics-export-estimate.use-case";
import { ExportAnalyticsExcelUseCase } from "../../src/core/modules/analytics/application/use-cases/export-analytics-excel.use-case";
import { AgentRepositoryFake } from "../support/agent-audit.fakes";
import { DepartmentRepositoryFake } from "../support/fakes";
import type { Agent } from "../../src/core/modules/departments/domain/agent.entity";

function createFakeRepo() {
  const overview: AnalyticsOverviewDto = {
    totalCases: 120,
    activeCases: 10,
    completedCases: 105,
    botContainmentRate: 45,
    avgResolutionTimeMinutes: 14.5,
    avgQueueWaitTimeSeconds: 40,
    escalationRate: 55,
    escalatedCases: 66,
    unassignedCases: 4,
    unattendedCases: 2,
  };

  const distribution: CasesDistributionDto = {
    totalCases: 120,
    byWorkflow: [{ workflowType: "BILLING_BALANCE", count: 120, percentage: 100 }],
    byFinalStatus: [{ status: "COMPLETED", count: 105, percentage: 87.5 }],
    topEscalationReasons: [{ reason: "cartera.retiro", count: 25, percentage: 100 }],
  };

  const aiEfficiency: AIEfficiencyDto = {
    overallContainmentRate: 45,
    botCompletedCases: 47,
    humanEscalatedCases: 66,
    funnelDropOff: [],
    unclearTriageCount: 3,
  };

  const departmentsSummary: DepartmentSummaryItemDto[] = [
    {
      departmentId: "dept-facturacion",
      departmentName: "Facturación",
      totalCases: 120,
      activeCases: 10,
      completedCases: 105,
      botContainmentRate: 45,
      escalationRate: 55,
      unassignedCases: 4,
      uniqueCustomersCount: 88,
      totalAgentsCount: 3,
      onShiftAgentsCount: 2,
      maxCapacity: 20,
      saturationPct: 80,
    },
  ];

  const agents: AgentPerformanceDto[] = [
    {
      agentId: "ag-1",
      agentName: "María Fernanda Torres",
      primaryDepartmentId: "dept-facturacion",
      primaryDepartmentName: "Facturación",
      role: "agent",
      autoAssignEnabled: true,
      activeCasesNow: 4,
      maxCapacityThreshold: 10,
      casesAssigned: 30,
      casesTouched: 42,
      casesCompleted: 35,
      casesResolved: 35,
      casesTransferred: 5,
      uniqueCustomersCount: 31,
      lastCaseAt: "2026-11-23T16:40:00.000Z",
      avgFirstResponseTimeMs: 95000,
      avgHandlingTimeMinutes: 12.4,
      fcrRatePercentage: 91.2,
      avgCordialityScore: 92,
      criticalAlertsCount: 0,
      openCoachingNotesCount: 0,
      unattendedActiveCases: 0,
      maxPendingWaitMinutes: null,
    },
    {
      agentId: "ag-2",
      agentName: "Carlos Andrés Mena",
      primaryDepartmentId: "dept-facturacion",
      primaryDepartmentName: "Facturación",
      role: "agent",
      autoAssignEnabled: true,
      activeCasesNow: 3,
      maxCapacityThreshold: 10,
      casesAssigned: 25,
      casesTouched: 30,
      casesCompleted: 23,
      casesResolved: 23,
      casesTransferred: 2,
      uniqueCustomersCount: 24,
      lastCaseAt: "2026-11-23T16:35:00.000Z",
      avgFirstResponseTimeMs: 110000,
      avgHandlingTimeMinutes: 15.1,
      fcrRatePercentage: 88.0,
      avgCordialityScore: 89,
      criticalAlertsCount: 0,
      openCoachingNotesCount: 0,
      unattendedActiveCases: 1,
      maxPendingWaitMinutes: 14,
    },
  ];

  const cases: AnalyticsCaseItemDto[] = [
    {
      caseId: "case-1",
      conversationId: "conv-1",
      createdAt: "2026-11-23T15:00:00.000Z",
      updatedAt: "2026-11-23T15:25:00.000Z",
      closedAt: "2026-11-23T15:25:00.000Z",
      status: "COMPLETED",
      workflowType: "BILLING_BALANCE",
      reason: "Acuerdo de pago",
      departmentId: "dept-facturacion",
      departmentName: "Facturación",
      customerKey: "cust-1",
      customerId: "cust-1",
      customerName: "Tamay Jacho Byron",
      waPhone: "+593998933690",
      nationalId: "1720941120",
      attentionMode: "AI_AND_HUMAN",
      ownerAgentId: "ag-2",
      ownerAgentName: "Carlos Andrés Mena",
      closedByAgentId: "ag-2",
      closedByAgentName: "Carlos Andrés Mena",
      participatingAgents: [
        { agentId: "ag-1", agentName: "María Fernanda Torres" },
        { agentId: "ag-2", agentName: "Carlos Andrés Mena" },
      ],
      handoffCount: 1,
    },
  ];

  const customers: AnalyticsCustomerItemDto[] = [
    {
      customerKey: "cust-1",
      customerId: "cust-1",
      customerName: "Tamay Jacho Byron",
      waPhone: "+593998933690",
      nationalId: "1720941120",
      departmentNames: ["Facturación"],
      totalCases: 2,
      completedCases: 2,
      activeCases: 0,
      lastCaseAt: "2026-11-23T15:00:00.000Z",
      lastCaseStatus: "COMPLETED",
      lastCaseWorkflowType: "BILLING_BALANCE",
      lastCaseReason: "Acuerdo de pago",
      lastConversationId: "conv-1",
      lastAgentId: "ag-2",
      lastAgentName: "Carlos Andrés Mena",
      participatingAgents: [
        { agentId: "ag-1", agentName: "María Fernanda Torres", casesCount: 1 },
        { agentId: "ag-2", agentName: "Carlos Andrés Mena", casesCount: 1 },
      ],
      distinctAgentsCount: 2,
      recentCases: [
        {
          caseId: "case-1",
          conversationId: "conv-1",
          createdAt: "2026-11-23T15:00:00.000Z",
          status: "COMPLETED",
          workflowType: "BILLING_BALANCE",
          reason: "Acuerdo de pago",
          departmentName: "Facturación",
          ownerAgentName: "Carlos Andrés Mena",
          participatingAgents: ["María Fernanda Torres", "Carlos Andrés Mena"],
        },
      ],
    },
  ];

  const repo: AnalyticsRepositoryPort = {
    getOverview: vi.fn(async (_f: AnalyticsFilter) => overview),
    getCasesDistribution: vi.fn(async (_f: AnalyticsFilter) => distribution),
    getAIEfficiency: vi.fn(async (_f: AnalyticsFilter) => aiEfficiency),
    getAgentsPerformance: vi.fn(async (_f: AnalyticsFilter, _t: number) => agents),
    getInfrastructureAlerts: vi.fn(async () => []),
    getDepartmentsSummary: vi.fn(async (_f: AnalyticsFilter, _t: number) => departmentsSummary),
    listAttendedCases: vi.fn(async (f: AnalyticsCasesQueryFilter) => ({
      items: f.page === 1 ? cases : [],
      total: cases.length,
      page: f.page,
      pageSize: f.pageSize,
    })),
    listAttendedCustomers: vi.fn(async (f: AnalyticsCustomersQueryFilter) => ({
      items: f.page === 1 ? customers : [],
      total: customers.length,
      page: f.page,
      pageSize: f.pageSize,
    })),
    getExportEstimate: vi.fn(async (_f: AnalyticsFilter, maxRowsPerSheet: number) => ({
      totalCases: 120,
      uniqueCustomers: 88,
      agentsCount: 2,
      departmentsCount: 1,
      maxRowsPerSheet,
      exceedsLimit: false,
    })),
  };

  return { repo };
}

async function collectStreamBuffer(writeFn: (stream: PassThrough) => Promise<void>): Promise<Buffer> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
  await writeFn(stream);
  return done;
}

describe("Analíticas granulares, alcance por rol y exportación Excel streaming", () => {
  const from = new Date("2026-10-24T00:00:00Z");
  const to = new Date("2026-11-23T23:59:59Z");

  const admin: Agent = {
    id: "admin-1",
    name: "Admin",
    email: "admin@isp.local",
    role: "admin",
    primaryDepartmentId: null,
    active: true,
    autoAssignEnabled: false,
    mustChangePassword: false,
    passwordHash: null,
    createdAt: new Date(),
  };

  const managerFacturacion: Agent = {
    id: "mgr-1",
    name: "Jefe Facturación",
    email: "mgr@isp.local",
    role: "manager",
    primaryDepartmentId: "dept-facturacion",
    active: true,
    autoAssignEnabled: false,
    mustChangePassword: false,
    passwordHash: null,
    createdAt: new Date(),
  };

  it("permite a admin consultar resumen de departamentos, casos, clientes y estimación", async () => {
    const { repo } = createFakeRepo();
    const agentRepo = new AgentRepositoryFake();

    const deptSummary = await new GetDepartmentsSummaryUseCase({
      analyticsRepo: repo,
      agentRepo,
      maxCapacityThreshold: 10,
    }).execute({ actor: admin, from, to });
    expect(deptSummary).toHaveLength(1);
    expect(deptSummary[0]?.uniqueCustomersCount).toBe(88);

    const casesRes = await new ListAnalyticsCasesUseCase({ analyticsRepo: repo, agentRepo }).execute({
      actor: admin,
      from,
      to,
      departmentId: "dept-facturacion",
      page: 1,
      pageSize: 25,
    });
    expect(casesRes.items[0]?.participatingAgents).toHaveLength(2);
    expect(casesRes.items[0]?.handoffCount).toBe(1);

    const customersRes = await new ListAnalyticsCustomersUseCase({
      analyticsRepo: repo,
      agentRepo,
    }).execute({
      actor: admin,
      from,
      to,
      departmentId: "dept-facturacion",
    });
    expect(customersRes.items).toHaveLength(1);
    expect(customersRes.items[0]?.distinctAgentsCount).toBe(2);

    const estimate = await new GetAnalyticsExportEstimateUseCase({
      analyticsRepo: repo,
      agentRepo,
    }).execute({ actor: admin, from, to });
    expect(estimate.totalCases).toBe(120);
    expect(estimate.uniqueCustomers).toBe(88);
  });

  it("bloquea a un manager que intenta listar o exportar un departamento fuera de su alcance", async () => {
    const { repo } = createFakeRepo();
    const agentRepo = new AgentRepositoryFake();

    const listCases = new ListAnalyticsCasesUseCase({ analyticsRepo: repo, agentRepo });
    await expect(
      listCases.execute({
        actor: managerFacturacion,
        from,
        to,
        departmentId: "dept-soporte",
      }),
    ).rejects.toThrow(/No tienes alcance sobre este departamento/);

    const exporter = new ExportAnalyticsExcelUseCase({
      analyticsRepo: repo,
      agentRepo,
      maxCapacityThreshold: 10,
    });
    await expect(
      exporter.prepare({
        actor: managerFacturacion,
        from,
        to,
        departmentId: "dept-soporte",
        sections: ["summary"],
      }),
    ).rejects.toThrow(/No tienes alcance sobre este departamento/);
  });

  it("exporta Excel streaming solo con las hojas solicitadas sin consultar casos ni clientes si no se seleccionan", async () => {
    const { repo } = createFakeRepo();
    const agentRepo = new AgentRepositoryFake();
    const deptRepo = new DepartmentRepositoryFake();
    const dept = deptRepo.seed({ id: "dept-facturacion", slug: "cartera", name: "Facturación" });

    const exporter = new ExportAnalyticsExcelUseCase({
      analyticsRepo: repo,
      agentRepo,
      departmentRepo: deptRepo,
      maxCapacityThreshold: 10,
    });

    const prepared = await exporter.prepare({
      actor: admin,
      from,
      to,
      departmentId: dept.id,
      sections: ["summary", "agents"],
    });
    expect(prepared.filename).toContain("reporte_analitica_facturacion_");

    const buffer = await collectStreamBuffer((stream) =>
      exporter.writeToStream({
        stream,
        from,
        to,
        departmentIds: prepared.departmentIds,
        areaLabel: prepared.areaLabel,
        sections: prepared.sections,
      }),
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheetNames = wb.worksheets.map((s) => s.name);
    expect(sheetNames).toEqual(["Resumen Ejecutivo", "Rendimiento Asesores"]);
    expect(repo.listAttendedCases).not.toHaveBeenCalled();
    expect(repo.listAttendedCustomers).not.toHaveBeenCalled();
  });

  it("exporta Excel streaming completo con las 4 hojas consolidando cadena multi-agente en casos y clientes", async () => {
    const { repo } = createFakeRepo();
    const agentRepo = new AgentRepositoryFake();
    const deptRepo = new DepartmentRepositoryFake();
    const dept = deptRepo.seed({ id: "dept-facturacion", slug: "cartera", name: "Facturación" });

    const exporter = new ExportAnalyticsExcelUseCase({
      analyticsRepo: repo,
      agentRepo,
      departmentRepo: deptRepo,
      maxCapacityThreshold: 10,
    });

    const prepared = await exporter.prepare({
      actor: admin,
      from,
      to,
      departmentId: dept.id,
      sections: ["summary", "agents", "cases", "customers"],
    });

    const buffer = await collectStreamBuffer((stream) =>
      exporter.writeToStream({
        stream,
        from,
        to,
        departmentIds: prepared.departmentIds,
        areaLabel: prepared.areaLabel,
        sections: prepared.sections,
      }),
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Resumen Ejecutivo",
      "Rendimiento Asesores",
      "Detalle de Casos",
      "Clientes Atendidos",
    ]);

    const agentsSheet = wb.getWorksheet("Rendimiento Asesores");
    expect(agentsSheet?.getRow(4).getCell(1).value).toBe("María Fernanda Torres");

    const casesSheet = wb.getWorksheet("Detalle de Casos");
    const caseDataRow = casesSheet?.getRow(4);
    expect(caseDataRow?.getCell(11).value).toBe("María Fernanda Torres → Carlos Andrés Mena");
    expect(caseDataRow?.getCell(12).value).toBe(1);
    expect(caseDataRow?.getCell(13).value).toBe("Resuelto / Cerrado");

    const customersSheet = wb.getWorksheet("Clientes Atendidos");
    const customerDataRow = customersSheet?.getRow(4);
    expect(customerDataRow?.getCell(1).value).toBe("Tamay Jacho Byron");
    expect(customerDataRow?.getCell(9).value).toBe("Resuelto / Cerrado");
    expect(customerDataRow?.getCell(12).value).toBe(2);
    expect(customerDataRow?.getCell(13).value).toBe(
      "María Fernanda Torres (1), Carlos Andrés Mena (1)",
    );
  });

  it("excluye admins y supervisores de otras áreas sin actividad en el departamento exportado", async () => {
    const { repo } = createFakeRepo();
    const agentRepo = new AgentRepositoryFake();
    const deptRepo = new DepartmentRepositoryFake();
    const factDept = deptRepo.seed({ id: "dept-facturacion", slug: "cartera", name: "Facturación" });

    vi.mocked(repo.getAgentsPerformance).mockResolvedValueOnce([
      {
        agentId: "ag-1",
        agentName: "Agente de Facturación",
        primaryDepartmentId: factDept.id,
        primaryDepartmentName: "Facturación",
        role: "agent",
        autoAssignEnabled: true,
        activeCasesNow: 2,
        maxCapacityThreshold: 10,
        casesAssigned: 10,
        casesTouched: 12,
        casesCompleted: 9,
        casesResolved: 9,
        casesTransferred: 1,
        uniqueCustomersCount: 11,
        lastCaseAt: "2026-11-23T16:00:00.000Z",
        avgFirstResponseTimeMs: 85000,
        avgHandlingTimeMinutes: 11.4,
        fcrRatePercentage: 90,
        avgCordialityScore: 91,
        criticalAlertsCount: 0,
        openCoachingNotesCount: 0,
      },
      {
        agentId: "adm-1",
        agentName: "Admin Global",
        primaryDepartmentId: null,
        primaryDepartmentName: null,
        role: "admin",
        autoAssignEnabled: true,
        activeCasesNow: 0,
        maxCapacityThreshold: 10,
        casesAssigned: 0,
        casesTouched: 0,
        casesCompleted: 0,
        casesResolved: 0,
        casesTransferred: 0,
        uniqueCustomersCount: 0,
        lastCaseAt: null,
        avgFirstResponseTimeMs: null,
        avgHandlingTimeMinutes: null,
        fcrRatePercentage: null,
        avgCordialityScore: null,
        criticalAlertsCount: 0,
        openCoachingNotesCount: 0,
      },
      {
        agentId: "mgr-other",
        agentName: "Manager Soporte",
        primaryDepartmentId: "dept-soporte",
        primaryDepartmentName: "Soporte Técnico",
        role: "manager",
        autoAssignEnabled: true,
        activeCasesNow: 0,
        maxCapacityThreshold: 10,
        casesAssigned: 0,
        casesTouched: 0,
        casesCompleted: 0,
        casesResolved: 0,
        casesTransferred: 0,
        uniqueCustomersCount: 0,
        lastCaseAt: null,
        avgFirstResponseTimeMs: null,
        avgHandlingTimeMinutes: null,
        fcrRatePercentage: null,
        avgCordialityScore: null,
        criticalAlertsCount: 0,
        openCoachingNotesCount: 0,
      },
    ]);

    const exporter = new ExportAnalyticsExcelUseCase({
      analyticsRepo: repo,
      agentRepo,
      departmentRepo: deptRepo,
      maxCapacityThreshold: 10,
    });
    const prepared = await exporter.prepare({
      actor: admin,
      from,
      to,
      departmentId: factDept.id,
      sections: ["agents"],
    });

    const buffer = await collectStreamBuffer((stream) =>
      exporter.writeToStream({
        stream,
        from,
        to,
        departmentIds: prepared.departmentIds,
        areaLabel: prepared.areaLabel,
        sections: prepared.sections,
      }),
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Rendimiento Asesores");
    const renderedNames: string[] = [];
    sheet?.eachRow((row, idx) => {
      if (idx >= 4) renderedNames.push(String(row.getCell(1).value ?? ""));
    });
    expect(renderedNames).toContain("Agente de Facturación");
    expect(renderedNames).not.toContain("Admin Global");
    expect(renderedNames).not.toContain("Manager Soporte");
  });

  it("rechaza rangos mayores a 92 días cuando se incluyen hojas pesadas (cases o customers)", async () => {
    const { repo } = createFakeRepo();
    const agentRepo = new AgentRepositoryFake();
    const exporter = new ExportAnalyticsExcelUseCase({
      analyticsRepo: repo,
      agentRepo,
      maxCapacityThreshold: 10,
    });

    await expect(
      exporter.prepare({
        actor: admin,
        from: new Date("2026-01-01T00:00:00Z"),
        to: new Date("2026-11-23T00:00:00Z"),
        sections: ["cases"],
      }),
    ).rejects.toThrow(/rango máximo permitido/);
  });
});
