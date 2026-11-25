import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { Env } from "../../../../shared/config/env";
import type { Logger } from "../../../../shared/logging/logger";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { DriveFileReportItem } from "../domain/drive-file-sync.entity";
import type { ReportDriveFileSyncUseCase } from "../application/use-cases/report-drive-file-sync.use-case";

export interface DriveSyncIntegrationRouterDeps {
  env: Env;
  reportDriveFileSync: ReportDriveFileSyncUseCase;
  logger: Logger;
}

function isAuthorizedInternalRequest(req: Request, expectedKey: string): boolean {
  const incoming = (
    req.header("x-internal-api-key") ||
    req.header("x-api-internal-key") ||
    ""
  ).trim();
  const expected = expectedKey.trim();
  if (!incoming || !expected) return false;
  const a = Buffer.from(incoming, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Router interno para reportes periódicos de n8n sobre metadatos de Google Drive
 * (CONTRATOS / CARTERA). Se monta antes de sessionMiddleware y valida X-Internal-Api-Key.
 */
export function createDriveSyncIntegrationRouter(
  deps: DriveSyncIntegrationRouterDeps,
): Router {
  const router = Router();
  const { env, reportDriveFileSync, logger } = deps;

  router.post("/api/integrations/drive-files/report", async (req, res, next) => {
    try {
      if (!isAuthorizedInternalRequest(req, env.API_INTERNAL_KEY)) {
        logger.warn({ path: req.path }, "reporte Drive rechazado por X-Internal-Api-Key inválida");
        res.status(401).json({
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Clave interna X-Internal-Api-Key inválida o ausente",
          },
        });
        return;
      }

      const body = req.body as
        | { files?: DriveFileReportItem[]; source?: string }
        | DriveFileReportItem
        | undefined;

      let files: DriveFileReportItem[] = [];
      let source: string | undefined;

      if (body && typeof body === "object" && "files" in body && Array.isArray(body.files)) {
        files = body.files;
        source = typeof body.source === "string" ? body.source : undefined;
      } else if (body && typeof body === "object" && "fileName" in body) {
        files = [body];
      } else {
        throw validationError("Se esperaba un campo 'files' (array) o un objeto con 'fileName' y 'modifiedTime'");
      }

      const result = await reportDriveFileSync.execute({ files, source });
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
