import { z } from "zod";

/**
 * Definición de archivo de Google Drive supervisado por el sistema.
 */
export const DriveMonitoredFileConfigSchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(120),
  expectedFileName: z.string().trim().min(1).max(200),
  expectedSheetName: z.string().trim().max(120).optional().nullable().default(null),
  fileId: z.string().trim().max(200).optional().nullable().default(null),
  staleThresholdHours: z.number().min(1).max(720).optional().nullable().default(null),
  enabled: z.boolean().default(true),
});

export type DriveMonitoredFileConfig = z.infer<typeof DriveMonitoredFileConfigSchema>;

export const DEFAULT_DRIVE_MONITORED_FILES: DriveMonitoredFileConfig[] = [
  {
    key: "CONTRATOS",
    label: "Contratos de Clientes",
    expectedFileName: "CONTRATOS",
    expectedSheetName: "ReporteContratos",
    fileId: "1wFaJYgCPCLmN3nPEah_NFNaS3l4XQccJJ8i9D48bsMo",
    staleThresholdHours: null,
    enabled: true,
  },
  {
    key: "CARTERA",
    label: "Cartera y Saldos",
    expectedFileName: "CARTERA",
    expectedSheetName: "Sheet",
    fileId: "1_kI__kiJjHEWoaC6YKtH1Bm1Yc6ZylWEAj_8rb7pbKY",
    staleThresholdHours: null,
    enabled: true,
  },
];

/**
 * Configuración de monitoreo y alertas para archivos de Google Drive en Telegram.
 */
export const TelegramDriveMonitorSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  staleThresholdHours: z.number().min(1).max(720).default(24),
  notifyOnModification: z.boolean().default(true),
  notifyOnStale: z.boolean().default(true),
  files: z.array(DriveMonitoredFileConfigSchema).default(DEFAULT_DRIVE_MONITORED_FILES),
});

export type TelegramDriveMonitorSettings = z.infer<typeof TelegramDriveMonitorSettingsSchema>;

export const DEFAULT_TELEGRAM_DRIVE_MONITOR: TelegramDriveMonitorSettings = {
  enabled: true,
  staleThresholdHours: 24,
  notifyOnModification: true,
  notifyOnStale: true,
  files: DEFAULT_DRIVE_MONITORED_FILES,
};

/**
 * Payload unitario reportado por n8n al inspeccionar archivos en Google Drive.
 */
export const DriveFileReportItemSchema = z.object({
  fileKey: z.string().trim().min(1).max(64).optional(),
  fileId: z.string().trim().max(200).optional().nullable(),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(200).optional().nullable(),
  modifiedTime: z.string().trim().min(1),
  modifiedBy: z.string().trim().max(200).optional().nullable(),
  modifiedByEmail: z.string().trim().max(200).optional().nullable(),
  webViewLink: z.string().trim().max(500).optional().nullable(),
  version: z.union([z.string(), z.number()]).optional().nullable(),
  revisionId: z.string().trim().max(200).optional().nullable(),
  sizeBytes: z.coerce.number().nonnegative().optional().nullable(),
});

export type DriveFileReportItem = z.infer<typeof DriveFileReportItemSchema>;

/**
 * Estado persistido del último snapshot conocido de un archivo supervisado en Drive.
 */
export interface DriveFileSyncStatusRecord {
  fileKey: string;
  label: string;
  fileId: string | null;
  fileName: string;
  expectedFileName: string;
  expectedSheetName: string | null;
  mimeType: string | null;
  lastModifiedTime: string | null;
  previousModifiedTime: string | null;
  lastModifiedBy: string | null;
  lastModifiedByEmail: string | null;
  webViewLink: string | null;
  version: string | null;
  lastReportedAt: string | null;
  lastNotifiedModifiedTime: string | null;
}

export interface DriveFileSyncState {
  updatedAt: string | null;
  records: Record<string, DriveFileSyncStatusRecord>;
}

const KNOWN_FILE_KEY_ALIASES: Record<string, string[]> = {
  CONTRATOS: ["contratos", "reportecontratos", "reporte_contratos", "contrato"],
  CARTERA: ["cartera", "saldos", "balance"],
};

function normalizeDriveName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.(xlsx|xls|csv|gsheet)$/i, "")
    .replace(/[\s_-]+/g, "");
}

/**
 * Resuelve a qué archivo configurado pertenece un reporte de Drive por clave, fileId o nombre.
 * El fallback por nombre permite sobrevivir a eliminaciones y re-subidas con distinto fileId.
 */
export function matchDriveFileConfig(
  configs: DriveMonitoredFileConfig[],
  report: Pick<DriveFileReportItem, "fileKey" | "fileId" | "fileName">,
): DriveMonitoredFileConfig | null {
  if (report.fileKey) {
    const byKey = configs.find(
      (c) => c.key.toUpperCase() === report.fileKey!.trim().toUpperCase(),
    );
    if (byKey) return byKey;
  }

  if (report.fileId && report.fileId.trim() !== "") {
    const byId = configs.find(
      (c) => c.fileId && c.fileId.trim() === report.fileId!.trim(),
    );
    if (byId) return byId;
  }

  const normalizedIncoming = normalizeDriveName(report.fileName);
  if (!normalizedIncoming) return null;

  for (const cfg of configs) {
    const expectedNorm = normalizeDriveName(cfg.expectedFileName);
    const sheetNorm = cfg.expectedSheetName ? normalizeDriveName(cfg.expectedSheetName) : "";
    if (
      normalizedIncoming === expectedNorm ||
      (sheetNorm && normalizedIncoming === sheetNorm) ||
      (expectedNorm && normalizedIncoming.includes(expectedNorm))
    ) {
      return cfg;
    }

    const aliases = KNOWN_FILE_KEY_ALIASES[cfg.key.toUpperCase()] ?? [];
    if (aliases.some((alias) => normalizedIncoming.includes(normalizeDriveName(alias)))) {
      return cfg;
    }
  }

  return null;
}

/**
 * Calcula horas transcurridas desde la última modificación y si excedió el umbral configurado.
 */
export function computeDriveFileStaleness(
  lastModifiedTime: string | null | undefined,
  thresholdHours: number,
  nowMs: number = Date.now(),
): {
  elapsedHours: number | null;
  isStale: boolean;
} {
  if (!lastModifiedTime) {
    return { elapsedHours: null, isStale: false };
  }
  const modifiedMs = Date.parse(lastModifiedTime);
  if (!Number.isFinite(modifiedMs)) {
    return { elapsedHours: null, isStale: false };
  }
  const elapsedHours = Math.max(0, (nowMs - modifiedMs) / 3_600_000);
  return {
    elapsedHours: Math.round(elapsedHours * 10) / 10,
    isStale: elapsedHours >= thresholdHours,
  };
}

/**
 * Formatea una fecha ISO en la zona horaria configurada para mensajes de Telegram.
 */
export function formatDriveTimestamp(
  isoDate: string | null | undefined,
  timeZone: string = "America/Guayaquil",
): string {
  if (!isoDate) return "Sin registro";
  const parsed = new Date(isoDate);
  if (!Number.isFinite(parsed.getTime())) return isoDate;
  return parsed.toLocaleString("es-EC", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Formatea una cantidad de minutos en lenguaje legible en español (días, horas y minutos).
 * Ejemplos: "25 minutos", "2 horas y 15 minutos", "3 días, 4 horas y 10 minutos".
 */
export function formatDurationMinutes(totalMinutes: number): string {
  const safeMinutes = Math.max(0, Math.round(totalMinutes));
  if (safeMinutes < 60) {
    return `${safeMinutes} ${safeMinutes === 1 ? "minuto" : "minutos"}`;
  }

  const days = Math.floor(safeMinutes / 1440);
  const remainingAfterDays = safeMinutes % 1440;
  const hours = Math.floor(remainingAfterDays / 60);
  const minutes = remainingAfterDays % 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${days === 1 ? "día" : "días"}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hora" : "horas"}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} ${minutes === 1 ? "minuto" : "minutos"}`);
  }

  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} y ${parts[1]}`;
  return `${parts[0]}, ${parts[1]} y ${parts[2]}`;
}

/**
 * Formatea duración transcurrida desde horas decimales en días, horas y minutos.
 */
export function formatElapsedHoursLabel(elapsedHours: number): string {
  const safeMinutes = Math.max(1, Math.round(elapsedHours * 60));
  return formatDurationMinutes(safeMinutes);
}
