import ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import type {
  AgentPerformanceDto,
  AIEfficiencyDto,
  AnalyticsExportSection,
  AnalyticsOverviewDto,
  CasesDistributionDto,
  DepartmentSummaryItemDto,
  PaginatedAnalyticsCasesDto,
  PaginatedAnalyticsCustomersDto,
} from "../../domain/analytics.types";
import {
  formatCaseStatusLabel,
  formatReasonLabel,
  formatWorkflowLabel,
} from "../../domain/analytics-labels";
import {
  NOTE_FONT,
  SUBHEADER_FILL,
  TITLE_FONT,
  filterRelevantAgentsForExport,
  formatAttentionMode,
  formatDateEc,
  formatFirstReply,
  formatRole,
  resolveNoHumanAgentLabel,
  setPercentCell,
  styleHeaderRow,
  styleTotalRow,
} from "./analytics-excel-styles";

export type StreamAnalyticsExcelInput = {
  stream: Writable;
  sections: Set<AnalyticsExportSection>;
  areaLabel: string;
  scopedDepartmentIds?: string[] | null;
  from: Date;
  to: Date;
  maxRowsPerSheet: number;
  batchSize?: number;
  loadSummaryData?: () => Promise<{
    overview: AnalyticsOverviewDto;
    distribution: CasesDistributionDto;
    aiEfficiency: AIEfficiencyDto;
    departmentsSummary: DepartmentSummaryItemDto[];
  }>;
  loadAgentsData?: () => Promise<AgentPerformanceDto[]>;
  fetchCasesPage?: (page: number, pageSize: number) => Promise<PaginatedAnalyticsCasesDto>;
  fetchCustomersPage?: (page: number, pageSize: number) => Promise<PaginatedAnalyticsCustomersDto>;
};

export function buildAnalyticsExcelFilename(areaLabel: string, now = new Date()): string {
  const dateStr = now.toISOString().slice(0, 10);
  const cleanArea = areaLabel
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "global";
  return `reporte_analitica_${cleanArea}_${dateStr}.xlsx`;
}

export async function streamAnalyticsExcelWorkbook(input: StreamAnalyticsExcelInput): Promise<void> {
  const batchSize = Math.min(Math.max(100, input.batchSize ?? 1000), 1000);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: input.stream,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = "Plataforma de Atención Omnicanal";
  workbook.created = new Date();

  const periodText = `${formatDateEc(input.from)} al ${formatDateEc(input.to)}`;
  const generatedText = formatDateEc(new Date());

  // ==========================================================
  // HOJA 1: RESUMEN EJECUTIVO Y COMPARATIVA DE DEPARTAMENTOS
  // ==========================================================
  if (input.sections.has("summary") && input.loadSummaryData) {
    const { overview, distribution, aiEfficiency, departmentsSummary } =
      await input.loadSummaryData();

    const sheet = workbook.addWorksheet("Resumen Ejecutivo");
    sheet.columns = [
      { width: 34 },
      { width: 16 },
      { width: 34 },
      { width: 15 },
      { width: 16 },
      { width: 16 },
      { width: 16 },
      { width: 16 },
      { width: 15 },
      { width: 15 },
      { width: 15 },
    ];

    const titleRow = sheet.addRow(["REPORTE OPERATIVO DE ATENCIÓN — RESUMEN EJECUTIVO"]);
    titleRow.font = TITLE_FONT;
    titleRow.commit();

    sheet.addRow(["Área / Alcance:", input.areaLabel]).commit();
    sheet.addRow(["Período Evaluado:", periodText]).commit();
    sheet.addRow(["Fecha de Emisión:", generatedText]).commit();
    sheet.addRow([]).commit();

    const kpiSectionRow = sheet.addRow(["1. INDICADORES PRINCIPALES DEL PERÍODO"]);
    kpiSectionRow.font = { bold: true, size: 11 };
    kpiSectionRow.getCell(1).fill = SUBHEADER_FILL;
    kpiSectionRow.commit();

    const kpiHeader = sheet.addRow(["Indicador", "Valor", "Explicación"]);
    styleHeaderRow(kpiHeader, 3);
    kpiHeader.commit();

    const numericKpiRows: Array<{ label: string; value: number; isPct?: boolean; note: string }> = [
      { label: "Total de Casos Recibidos", value: overview.totalCases, note: "Conversaciones/casos abiertos en el período" },
      { label: "Casos Resueltos / Cerrados", value: overview.completedCases, note: "Casos finalizados (IA o asesor humano)" },
      { label: "Casos Activos Actualmente", value: overview.activeCases, note: "Casos abiertos en este momento" },
      { label: "Casos Resueltos solo por IA", value: aiEfficiency.botCompletedCases, note: "Atendidos y cerrados automáticamente sin asesor" },
      { label: "Resolución Automática IA (%)", value: overview.botContainmentRate, isPct: true, note: "Porcentaje de cerrados que resolvió la IA sola" },
      { label: "Casos Derivados a Asesor Humano", value: overview.escalatedCases ?? aiEfficiency.humanEscalatedCases, note: "Casos que requirieron atención humana" },
      { label: "Tasa de Derivación a Asesor (%)", value: overview.escalationRate, isPct: true, note: "Porcentaje de casos derivados a equipo humano" },
      { label: "Tiempo Promedio de Resolución (min)", value: overview.avgResolutionTimeMinutes ?? 0, note: "Minutos desde ingreso hasta cierre" },
      { label: "Espera Promedio en Cola (seg)", value: overview.avgQueueWaitTimeSeconds ?? 0, note: "Segundos esperando hasta ser tomado por un asesor" },
      { label: "En Cola Sin Asignar (Ahora)", value: overview.unassignedCases ?? 0, note: "Casos esperando un asesor en este momento" },
      { label: "Sin Respuesta Pendiente (Alerta)", value: overview.unattendedCases ?? 0, note: "Casos asignados con cliente esperando respuesta" },
    ];

    for (const k of numericKpiRows) {
      const row = sheet.addRow([k.label, k.value, k.note]);
      if (k.isPct) {
        setPercentCell(row.getCell(2), k.value);
      } else {
        row.getCell(2).numFmt = Number.isInteger(k.value) ? "#,##0" : "0.0";
      }
      row.commit();
    }

    sheet.addRow([]).commit();
    const deptSectionRow = sheet.addRow(["2. COMPARATIVA POR DEPARTAMENTO"]);
    deptSectionRow.font = { bold: true, size: 11 };
    deptSectionRow.getCell(1).fill = SUBHEADER_FILL;
    deptSectionRow.commit();

    const deptHeader = sheet.addRow([
      "Departamento",
      "Casos Totales",
      "Resueltos",
      "Activos Ahora",
      "Resolución IA (%)",
      "Derivación (%)",
      "Clientes Únicos",
      "Sin Asignar",
      "Asesores Turno",
      "Capacidad Máx.",
      "Ocupación (%)",
    ]);
    styleHeaderRow(deptHeader, 11);
    deptHeader.commit();

    let sumDeptCases = 0;
    let sumDeptResolved = 0;
    let sumDeptActive = 0;
    let sumDeptCustomers = 0;
    let sumDeptUnassigned = 0;

    for (const d of departmentsSummary) {
      sumDeptCases += d.totalCases;
      sumDeptResolved += d.completedCases;
      sumDeptActive += d.activeCases;
      sumDeptCustomers += d.uniqueCustomersCount;
      sumDeptUnassigned += d.unassignedCases;

      const row = sheet.addRow([
        d.departmentName,
        d.totalCases,
        d.completedCases,
        d.activeCases,
        0,
        0,
        d.uniqueCustomersCount,
        d.unassignedCases,
        d.onShiftAgentsCount,
        d.maxCapacity,
        0,
      ]);
      setPercentCell(row.getCell(5), d.botContainmentRate);
      setPercentCell(row.getCell(6), d.escalationRate);
      setPercentCell(row.getCell(11), d.saturationPct);
      row.commit();
    }

    if (departmentsSummary.length > 1) {
      const totalRow = sheet.addRow([
        "TOTAL CONSOLIDADO",
        sumDeptCases,
        sumDeptResolved,
        sumDeptActive,
        "—",
        "—",
        sumDeptCustomers,
        sumDeptUnassigned,
        "",
        "",
        "",
      ]);
      styleTotalRow(totalRow, 11);
      totalRow.commit();
    }

    sheet.addRow([]).commit();
    const wfSectionRow = sheet.addRow(["3. DISTRIBUCIÓN POR TIPO DE GESTIÓN"]);
    wfSectionRow.font = { bold: true, size: 11 };
    wfSectionRow.getCell(1).fill = SUBHEADER_FILL;
    wfSectionRow.commit();

    const wfHeader = sheet.addRow(["Tipo de Gestión / Área", "Casos", "Participación (%)"]);
    styleHeaderRow(wfHeader, 3);
    wfHeader.commit();

    for (const wf of distribution.byWorkflow) {
      const row = sheet.addRow([formatWorkflowLabel(wf.workflowType), wf.count, 0]);
      setPercentCell(row.getCell(3), wf.percentage);
      row.commit();
    }

    sheet.commit();
  }

  // ==========================================================
  // HOJA 2: RENDIMIENTO DE ASESORES (SIN USUARIOS SIN ACTIVIDAD)
  // ==========================================================
  if (input.sections.has("agents") && input.loadAgentsData) {
    const rawAgents = await input.loadAgentsData();
    const agents = filterRelevantAgentsForExport(rawAgents, input.scopedDepartmentIds);
    const sheet = workbook.addWorksheet("Rendimiento Asesores", {
      views: [{ state: "frozen", ySplit: 3 }],
    });
    sheet.columns = [
      { width: 28 },
      { width: 22 },
      { width: 17 },
      { width: 17 },
      { width: 16 },
      { width: 17 },
      { width: 16 },
      { width: 20 },
      { width: 16 },
      { width: 19 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 15 },
      { width: 15 },
    ];

    const titleRow = sheet.addRow([`RENDIMIENTO DE ASESORES — ${input.areaLabel} (${periodText})`]);
    titleRow.font = TITLE_FONT;
    titleRow.commit();

    const noteRow = sheet.addRow([
      "Casos Intervenidos incluye casos atendidos por más de un asesor. Casos Resueltos se asigna únicamente al asesor que cerró el caso y cuadra con el total del departamento.",
    ]);
    noteRow.font = NOTE_FONT;
    noteRow.commit();

    const header = sheet.addRow([
      "Asesor",
      "Departamento Base",
      "Rol",
      "Casos Intervenidos",
      "Casos Resueltos",
      "Casos Transferidos",
      "Clientes Únicos",
      "Último Caso Atendido",
      "1ª Respuesta",
      "Duración Media (min)",
      "Efectividad 48h",
      "Cordialidad",
      "Activos Ahora",
      "Sin Responder",
      "En Turno Auto",
    ]);
    styleHeaderRow(header, 15);
    header.commit();

    const sorted = [...agents].sort(
      (a, b) => b.casesResolved - a.casesResolved || b.casesTouched - a.casesTouched,
    );

    let sumResolved = 0;
    let sumTransferred = 0;
    let sumActive = 0;
    let sumUnattended = 0;

    for (const a of sorted) {
      sumResolved += a.casesResolved;
      sumTransferred += a.casesTransferred;
      sumActive += a.activeCasesNow;
      sumUnattended += a.unattendedActiveCases ?? 0;

      const row = sheet.addRow([
        a.agentName,
        a.primaryDepartmentName ?? "Multidepartamento",
        formatRole(a.role),
        a.casesTouched,
        a.casesResolved,
        a.casesTransferred,
        a.uniqueCustomersCount,
        formatDateEc(a.lastCaseAt),
        formatFirstReply(a.avgFirstResponseTimeMs),
        a.avgHandlingTimeMinutes !== null ? Number(a.avgHandlingTimeMinutes.toFixed(1)) : "—",
        0,
        a.avgCordialityScore !== null ? a.avgCordialityScore : "—",
        a.activeCasesNow,
        a.unattendedActiveCases ?? 0,
        a.autoAssignEnabled ? "Sí" : "No",
      ]);
      setPercentCell(row.getCell(11), a.fcrRatePercentage);
      if (a.avgHandlingTimeMinutes !== null) {
        row.getCell(10).numFmt = "0.0";
      }
      row.commit();
    }

    const totalRow = sheet.addRow([
      `TOTAL (${sorted.length} asesores)`,
      "",
      "",
      "—",
      sumResolved,
      sumTransferred,
      "—",
      "",
      "",
      "",
      "",
      "",
      sumActive,
      sumUnattended,
      "",
    ]);
    styleTotalRow(totalRow, 15);
    totalRow.commit();

    sheet.commit();
  }

  // ==========================================================
  // HOJA 3: DETALLE DE CASOS ATENDIDOS (LENGUAJE DE NEGOCIO)
  // ==========================================================
  if (input.sections.has("cases") && input.fetchCasesPage) {
    const sheet = workbook.addWorksheet("Detalle de Casos", {
      views: [{ state: "frozen", ySplit: 3 }],
    });
    sheet.columns = [
      { width: 18 },
      { width: 28 },
      { width: 17 },
      { width: 15 },
      { width: 20 },
      { width: 24 },
      { width: 34 },
      { width: 20 },
      { width: 24 },
      { width: 24 },
      { width: 38 },
      { width: 12 },
      { width: 24 },
      { width: 18 },
      { width: 14 },
    ];

    const titleRow = sheet.addRow([`DETALLE DE CASOS ATENDIDOS — ${input.areaLabel} (${periodText})`]);
    titleRow.font = TITLE_FONT;
    titleRow.commit();

    const noteRow = sheet.addRow([
      "Cada fila representa un caso único. Si intervino más de un asesor, en 'Asesores Participantes' se ve el recorrido completo.",
    ]);
    noteRow.font = NOTE_FONT;
    noteRow.commit();

    const header = sheet.addRow([
      "Fecha Ingreso",
      "Cliente",
      "Teléfono",
      "Cédula",
      "Departamento",
      "Tipo de Gestión",
      "Motivo / Consulta",
      "Modo de Atención",
      "Asesor Responsable",
      "Cerrado Por",
      "Asesores Participantes",
      "Traspasos",
      "Estado Actual",
      "Fecha Cierre",
      "Ref. Caso",
    ]);
    styleHeaderRow(header, 15);
    header.commit();

    let written = 0;
    let page = 1;
    let totalAvailable = 0;

    while (written < input.maxRowsPerSheet) {
      const remaining = input.maxRowsPerSheet - written;
      const limit = Math.min(batchSize, remaining);
      const res = await input.fetchCasesPage(page, limit);
      totalAvailable = res.total;
      if (res.items.length === 0) break;

      for (const item of res.items) {
        const chain =
          item.participatingAgents.length > 0
            ? item.participatingAgents.map((p) => p.agentName).join(" → ")
            : resolveNoHumanAgentLabel(item.status, item.attentionMode, "participants");

        const ownerLabel =
          item.ownerAgentName ??
          resolveNoHumanAgentLabel(item.status, item.attentionMode, "owner");

        const closedByLabel =
          item.closedByAgentName ??
          (item.status === "COMPLETED" && item.attentionMode === "AI_ONLY"
            ? "Asistente Virtual IA"
            : item.status === "COMPLETED"
              ? "Cierre automático del sistema"
              : "—");

        const row = sheet.addRow([
          formatDateEc(item.createdAt),
          item.customerName,
          item.waPhone,
          item.nationalId ?? "—",
          item.departmentName,
          formatWorkflowLabel(item.workflowType),
          formatReasonLabel(item.reason, item.workflowType),
          formatAttentionMode(item.attentionMode),
          ownerLabel,
          closedByLabel,
          chain,
          item.handoffCount,
          formatCaseStatusLabel(item.status),
          formatDateEc(item.closedAt),
          `#${item.caseId.slice(0, 8).toUpperCase()}`,
        ]);
        row.alignment = { vertical: "middle", wrapText: true };
        row.commit();
        written += 1;
      }

      if (written >= totalAvailable || res.items.length < limit) break;
      page += 1;
    }

    const footerRow = sheet.addRow([`TOTAL CASOS EXPORTADOS: ${written}`]);
    styleTotalRow(footerRow, 15);
    footerRow.commit();

    if (totalAvailable > input.maxRowsPerSheet) {
      const warnRow = sheet.addRow([
        `AVISO: Se exportaron los primeros ${input.maxRowsPerSheet} de ${totalAvailable} casos. Reduce el rango de fechas para descargar el resto.`,
      ]);
      warnRow.font = { bold: true, color: { argb: "FFB91C1C" } };
      warnRow.commit();
    }

    sheet.commit();
  }

  // ==========================================================
  // HOJA 4: CLIENTES ATENDIDOS ÚNICOS (SIN DUPLICADOS)
  // ==========================================================
  if (input.sections.has("customers") && input.fetchCustomersPage) {
    const sheet = workbook.addWorksheet("Clientes Atendidos", {
      views: [{ state: "frozen", ySplit: 3 }],
    });
    sheet.columns = [
      { width: 28 },
      { width: 18 },
      { width: 15 },
      { width: 24 },
      { width: 13 },
      { width: 13 },
      { width: 13 },
      { width: 20 },
      { width: 25 },
      { width: 36 },
      { width: 25 },
      { width: 16 },
      { width: 42 },
    ];

    const titleRow = sheet.addRow([`CLIENTES ATENDIDOS (ÚNICOS) — ${input.areaLabel} (${periodText})`]);
    titleRow.font = TITLE_FONT;
    titleRow.commit();

    const noteRow = sheet.addRow([
      "Cada cliente aparece una sola vez sin importar cuántos casos abrió o cuántos asesores lo atendieron.",
    ]);
    noteRow.font = NOTE_FONT;
    noteRow.commit();

    const header = sheet.addRow([
      "Cliente",
      "Teléfono",
      "Cédula",
      "Departamento(s)",
      "Total Casos",
      "Resueltos",
      "Activos",
      "Última Atención",
      "Estado Últ. Caso",
      "Motivo Últ. Caso",
      "Último Responsable",
      "Asesores Distintos",
      "Todos los Asesores Participantes",
    ]);
    styleHeaderRow(header, 13);
    header.commit();

    let written = 0;
    let page = 1;
    let totalAvailable = 0;
    let sumTotalCases = 0;
    let sumCompletedCases = 0;
    let sumActiveCases = 0;

    while (written < input.maxRowsPerSheet) {
      const remaining = input.maxRowsPerSheet - written;
      const limit = Math.min(batchSize, remaining);
      const res = await input.fetchCustomersPage(page, limit);
      totalAvailable = res.total;
      if (res.items.length === 0) break;

      for (const c of res.items) {
        sumTotalCases += c.totalCases;
        sumCompletedCases += c.completedCases;
        sumActiveCases += c.activeCases;

        const isPendingHuman = c.lastCaseStatus.toUpperCase() === "ESCALATED";
        const agentsSummary =
          c.participatingAgents.length > 0
            ? c.participatingAgents.map((a) => `${a.agentName} (${a.casesCount})`).join(", ")
            : isPendingHuman
              ? "En cola de espera (Sin asesor)"
              : "Asistente Virtual IA (Automático)";

        const lastAgentLabel =
          c.lastAgentName ??
          (isPendingHuman ? "Pendiente de asignar" : "Asistente Virtual IA");

        const row = sheet.addRow([
          c.customerName,
          c.waPhone,
          c.nationalId ?? "—",
          c.departmentNames.join(", ") || "General / Sin Área",
          c.totalCases,
          c.completedCases,
          c.activeCases,
          formatDateEc(c.lastCaseAt),
          formatCaseStatusLabel(c.lastCaseStatus),
          formatReasonLabel(c.lastCaseReason, c.lastCaseWorkflowType),
          lastAgentLabel,
          c.distinctAgentsCount,
          agentsSummary,
        ]);
        row.alignment = { vertical: "middle", wrapText: true };
        row.commit();
        written += 1;
      }

      if (written >= totalAvailable || res.items.length < limit) break;
      page += 1;
    }

    const totalRow = sheet.addRow([
      `TOTAL: ${written} clientes únicos`,
      "",
      "",
      "",
      sumTotalCases,
      sumCompletedCases,
      sumActiveCases,
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    styleTotalRow(totalRow, 13);
    totalRow.commit();

    if (totalAvailable > input.maxRowsPerSheet) {
      const warnRow = sheet.addRow([
        `AVISO: Se exportaron los primeros ${input.maxRowsPerSheet} de ${totalAvailable} clientes únicos. Reduce el rango de fechas para descargar el resto.`,
      ]);
      warnRow.font = { bold: true, color: { argb: "FFB91C1C" } };
      warnRow.commit();
    }

    sheet.commit();
  }

  await workbook.commit();
}
