import type ExcelJS from "exceljs";
import type { AgentPerformanceDto, AnalyticsCaseAttentionMode } from "../../domain/analytics.types";

export const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF0F172A" },
};

export const SUBHEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE2E8F0" },
};

export const TOTAL_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFF1F5F9" },
};

export const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FFFFFFFF" },
  size: 10,
};

export const TITLE_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 13,
  color: { argb: "FF0F172A" },
};

export const NOTE_FONT: Partial<ExcelJS.Font> = {
  italic: true,
  size: 9,
  color: { argb: "FF475569" },
};

export const TOTAL_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 10,
  color: { argb: "FF0F172A" },
};

export function formatDateEc(iso?: string | Date | null): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d
    .toLocaleString("es-EC", {
      timeZone: "America/Guayaquil",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .replace(",", "");
}

export function formatAttentionMode(mode: AnalyticsCaseAttentionMode): string {
  switch (mode) {
    case "AI_ONLY":
      return "Atención Automática IA";
    case "AI_AND_HUMAN":
      return "IA + Asesor Humano";
    case "HUMAN_DIRECT":
      return "Asesor Directo";
  }
}

export function formatRole(role: string): string {
  if (role === "admin") return "Administrador";
  if (role === "manager") return "Supervisor / Jefe";
  return "Asesor";
}

export function formatFirstReply(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = sec / 60;
  return min < 60 ? `${min.toFixed(1)} min` : `${(min / 60).toFixed(1)} h`;
}

export function styleHeaderRow(row: ExcelJS.Row, colCount: number): void {
  row.font = HEADER_FONT;
  row.height = 24;
  for (let i = 1; i <= colCount; i += 1) {
    const cell = row.getCell(i);
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  }
}

export function styleTotalRow(row: ExcelJS.Row, colCount: number): void {
  row.font = TOTAL_FONT;
  row.height = 22;
  for (let i = 1; i <= colCount; i += 1) {
    const cell = row.getCell(i);
    cell.fill = TOTAL_FILL;
    cell.border = {
      top: { style: "thin", color: { argb: "FF94A3B8" } },
      bottom: { style: "double", color: { argb: "FF0F172A" } },
    };
  }
}

export function setPercentCell(cell: ExcelJS.Cell, percentZeroToHundred: number | null): void {
  if (percentZeroToHundred === null || percentZeroToHundred === undefined) {
    cell.value = "—";
    return;
  }
  cell.value = Number((percentZeroToHundred / 100).toFixed(4));
  cell.numFmt = "0.0%";
}

export function filterRelevantAgentsForExport(
  agents: AgentPerformanceDto[],
  scopedDepartmentIds?: string[] | null,
): AgentPerformanceDto[] {
  const singleDeptId =
    scopedDepartmentIds && scopedDepartmentIds.length === 1 ? scopedDepartmentIds[0] : null;

  return agents.filter((a) => {
    const hasActivity =
      a.casesTouched > 0 ||
      a.casesResolved > 0 ||
      a.casesTransferred > 0 ||
      a.activeCasesNow > 0 ||
      a.uniqueCustomersCount > 0;

    if (hasActivity) return true;
    // Administradores sin actividad operativa no ensucian tablas de asesores
    if (a.role === "admin") return false;
    // Supervisores de otra área con membresía solo de lectura y 0 casos tampoco
    if (singleDeptId && a.primaryDepartmentId !== singleDeptId) return false;
    return true;
  });
}

export function resolveNoHumanAgentLabel(
  status: string,
  mode: AnalyticsCaseAttentionMode,
  field: "owner" | "participants",
): string {
  const upper = status.toUpperCase();
  if (upper === "ESCALATED") {
    return field === "owner" ? "Pendiente de asignar" : "En cola de espera (Sin asesor)";
  }
  if (mode === "AI_ONLY" || upper === "COMPLETED" || upper === "ACTIVE" || upper === "WAITING_USER") {
    return field === "owner" ? "Asistente Virtual IA" : "Asistente Virtual IA (Automático)";
  }
  return field === "owner" ? "Sin asesor asignado" : "Sin intervención humana";
}
