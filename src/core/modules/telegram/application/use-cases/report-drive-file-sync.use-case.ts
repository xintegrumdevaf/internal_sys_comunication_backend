import type { Logger } from "../../../../../shared/logging/logger";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import {
  DEFAULT_TELEGRAM_DRIVE_MONITOR,
  type DriveFileReportItem,
  DriveFileReportItemSchema,
  type DriveFileSyncState,
  type DriveFileSyncStatusRecord,
  formatDriveTimestamp,
  matchDriveFileConfig,
} from "../../domain/drive-file-sync.entity";
import type { DriveFileSyncStorePort } from "../ports/drive-file-sync.store.port";
import type { AlertCooldownCacheService } from "../services/alert-cooldown-cache.service";
import type { SendTelegramAlertUseCase } from "./send-telegram-alert.use-case";

export interface ReportDriveFileSyncDeps {
  driveFileSyncStore: DriveFileSyncStorePort;
  sendTelegramAlert: SendTelegramAlertUseCase;
  getSettings: () => Promise<TelegramSettings>;
  cooldownCache?: AlertCooldownCacheService;
  frontendUrl?: string;
  logger: Logger;
}

export interface ReportDriveFileSyncInput {
  files: DriveFileReportItem[];
  source?: string;
}

export interface ReportDriveFileSyncItemResult {
  fileKey: string;
  fileName: string;
  status: "changed" | "unchanged" | "initialized" | "ignored";
  modifiedTime: string | null;
  modifiedBy: string | null;
  alertSent: boolean;
}

export interface ReportDriveFileSyncResult {
  processedCount: number;
  changedCount: number;
  initializedCount: number;
  alertsDispatched: number;
  results: ReportDriveFileSyncItemResult[];
}

export class ReportDriveFileSyncUseCase {
  constructor(private readonly deps: ReportDriveFileSyncDeps) {}

  async execute(input: ReportDriveFileSyncInput): Promise<ReportDriveFileSyncResult> {
    const settings = await this.deps.getSettings();
    const driveSettings = settings.driveMonitor ?? DEFAULT_TELEGRAM_DRIVE_MONITOR;
    const timeZone = settings.timeZone || "America/Guayaquil";
    const effectiveFrontendUrl = (
      settings.frontendUrl && settings.frontendUrl.trim() !== ""
        ? settings.frontendUrl.trim()
        : (this.deps.frontendUrl || "http://localhost:8080")
    ).replace(/\/$/, "");

    const currentState: DriveFileSyncState = await this.deps.driveFileSyncStore.getState();
    const nextRecords: Record<string, DriveFileSyncStatusRecord> = { ...currentState.records };
    const nowIso = new Date().toISOString();

    const results: ReportDriveFileSyncItemResult[] = [];
    let changedCount = 0;
    let initializedCount = 0;
    let alertsDispatched = 0;
    let stateDirty = false;

    for (const rawItem of input.files) {
      const parsedItem = DriveFileReportItemSchema.safeParse(rawItem);
      if (!parsedItem.success) {
        this.deps.logger.warn(
          { issues: parsedItem.error.issues, rawItem },
          "reporte de archivo Drive inválido; omitido",
        );
        results.push({
          fileKey: rawItem?.fileKey || "UNKNOWN",
          fileName: rawItem?.fileName || "unknown",
          status: "ignored",
          modifiedTime: null,
          modifiedBy: null,
          alertSent: false,
        });
        continue;
      }

      const item = parsedItem.data;
      const parsedMs = Date.parse(item.modifiedTime);
      if (!Number.isFinite(parsedMs)) {
        this.deps.logger.warn(
          { fileName: item.fileName, modifiedTime: item.modifiedTime },
          "modifiedTime inválido recibido desde Drive monitor",
        );
        results.push({
          fileKey: item.fileKey || "UNKNOWN",
          fileName: item.fileName,
          status: "ignored",
          modifiedTime: null,
          modifiedBy: item.modifiedBy ?? null,
          alertSent: false,
        });
        continue;
      }

      const normalizedModifiedTime = new Date(parsedMs).toISOString();
      const matched = matchDriveFileConfig(driveSettings.files, item);
      if (!matched) {
        this.deps.logger.debug(
          { fileName: item.fileName, fileId: item.fileId },
          "archivo reportado por n8n no coincide con ningún archivo supervisado",
        );
        results.push({
          fileKey: item.fileKey || item.fileName,
          fileName: item.fileName,
          status: "ignored",
          modifiedTime: normalizedModifiedTime,
          modifiedBy: item.modifiedBy ?? null,
          alertSent: false,
        });
        continue;
      }

      const prevRecord = nextRecords[matched.key];
      const prevModifiedMs = prevRecord?.lastModifiedTime
        ? Date.parse(prevRecord.lastModifiedTime)
        : NaN;
      const isBaselineInit = !prevRecord || !Number.isFinite(prevModifiedMs);
      const hasModifiedChanged = !isBaselineInit && prevModifiedMs !== parsedMs;

      const editorName = item.modifiedBy?.trim() || null;
      const editorEmail = item.modifiedByEmail?.trim() || null;
      const versionStr =
        item.revisionId?.trim() ||
        (item.version !== undefined && item.version !== null && String(item.version).trim() !== ""
          ? String(item.version).trim()
          : null);

      let alertSent = false;

      if (hasModifiedChanged) {
        changedCount++;
        if (this.deps.cooldownCache) {
          if (typeof this.deps.cooldownCache.clearAsync === "function") {
            await this.deps.cooldownCache.clearAsync(`drive:stale:${matched.key}`);
          } else {
            this.deps.cooldownCache.clear(`drive:stale:${matched.key}`);
          }
        }

        if (
          driveSettings.enabled &&
          driveSettings.notifyOnModification &&
          matched.enabled
        ) {
          const formattedModifiedAt = formatDriveTimestamp(normalizedModifiedTime, timeZone);
          const formattedPrevAt = formatDriveTimestamp(prevRecord?.lastModifiedTime, timeZone);
          const editorDisplay = editorName
            ? editorEmail
              ? `${editorName} (${editorEmail})`
              : editorName
            : editorEmail || "Usuario no especificado por Drive";

          const metadata: Record<string, string | number | boolean | null | undefined> = {
            "Archivo": `${matched.label} (${matched.key})`,
            "Nombre en Drive": item.fileName,
            "Hora de modificación": formattedModifiedAt,
            "Modificado por": editorName || editorEmail || "No reportado por Drive",
            "Modificación anterior": formattedPrevAt,
          };
          if (editorEmail && editorName) {
            metadata["Correo del editor"] = editorEmail;
          }
          if (versionStr) {
            metadata["Versión / Revisión"] = versionStr;
          }

          const actions = item.webViewLink
            ? [{ label: "📄 Abrir archivo en Drive", url: item.webViewLink }]
            : [{ label: "⚙️ Ver Monitor en Panel", url: `${effectiveFrontendUrl}/configuracion` }];

          try {
            const sendResult = await this.deps.sendTelegramAlert.execute({
              category: "DRIVE_SYNC",
              severity: "INFO",
              title: `Archivo actualizado en Drive: ${item.fileName}`,
              body: `Se detectó una modificación en ${matched.label} (${item.fileName}). Fue alterado por ${editorDisplay} el ${formattedModifiedAt}.`,
              metadata,
              actions,
            });
            alertSent = Boolean(sendResult?.ok);
            if (alertSent) {
              alertsDispatched++;
            }
          } catch (err) {
            this.deps.logger.warn(
              { err, fileKey: matched.key, fileName: item.fileName },
              "no se pudo despachar alerta de modificación de Drive a Telegram",
            );
          }
        }
      } else if (isBaselineInit) {
        initializedCount++;
      }

      nextRecords[matched.key] = {
        fileKey: matched.key,
        label: matched.label,
        fileId: item.fileId?.trim() || prevRecord?.fileId || matched.fileId || null,
        fileName: item.fileName,
        expectedFileName: matched.expectedFileName,
        expectedSheetName: matched.expectedSheetName ?? null,
        mimeType: item.mimeType?.trim() || prevRecord?.mimeType || null,
        lastModifiedTime: normalizedModifiedTime,
        previousModifiedTime: hasModifiedChanged
          ? (prevRecord?.lastModifiedTime ?? null)
          : (prevRecord?.previousModifiedTime ?? null),
        lastModifiedBy: editorName || (hasModifiedChanged ? null : prevRecord?.lastModifiedBy ?? null),
        lastModifiedByEmail: editorEmail || (hasModifiedChanged ? null : prevRecord?.lastModifiedByEmail ?? null),
        webViewLink: item.webViewLink?.trim() || prevRecord?.webViewLink || null,
        version: versionStr || (hasModifiedChanged ? null : prevRecord?.version ?? null),
        lastReportedAt: nowIso,
        lastNotifiedModifiedTime: alertSent
          ? normalizedModifiedTime
          : (prevRecord?.lastNotifiedModifiedTime ?? null),
      };
      stateDirty = true;

      results.push({
        fileKey: matched.key,
        fileName: item.fileName,
        status: hasModifiedChanged ? "changed" : isBaselineInit ? "initialized" : "unchanged",
        modifiedTime: normalizedModifiedTime,
        modifiedBy: editorName || editorEmail,
        alertSent,
      });
    }

    if (stateDirty) {
      await this.deps.driveFileSyncStore.saveState({
        updatedAt: nowIso,
        records: nextRecords,
      });
    }

    return {
      processedCount: results.length,
      changedCount,
      initializedCount,
      alertsDispatched,
      results,
    };
  }
}
