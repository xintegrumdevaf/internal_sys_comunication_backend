import { Router } from "express";
import multer from "multer";
import { requireRole } from "../../../../shared/http/require-auth";
import type { CoverageService } from "../application/services/coverage.service";

import zlib from "node:zlib";

function extractKmlFromBuffer(buffer: Buffer): string {
  // Check ZIP magic bytes (PK\x03\x04) for KMZ archives
  if (buffer.length >= 30 && buffer.readUInt32LE(0) === 0x04034b50) {
    let offset = 0;
    while (offset + 30 < buffer.length) {
      if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
      const compression = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const fileNameLen = buffer.readUInt16LE(offset + 26);
      const extraFieldLen = buffer.readUInt16LE(offset + 28);
      const fileName = buffer.toString("utf-8", offset + 30, offset + 30 + fileNameLen);
      const dataOffset = offset + 30 + fileNameLen + extraFieldLen;
      const data = buffer.subarray(dataOffset, dataOffset + compressedSize);

      if (fileName.toLowerCase().endsWith(".kml")) {
        if (compression === 0) return data.toString("utf-8");
        if (compression === 8) return zlib.inflateRawSync(data).toString("utf-8");
      }
      offset = dataOffset + compressedSize;
    }
  }
  return buffer.toString("utf-8");
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

export interface CoverageRouterDeps {
  coverageService: CoverageService;
}

export function createCoverageRouter({ coverageService }: CoverageRouterDeps): Router {
  const router = Router();

  // GET /api/coverage/zones - Listar zonas activas con resumen
  router.get("/api/coverage/zones", async (_req, res, next) => {
    try {
      const zones = coverageService.getZones().map((z) => ({
        name: z.name,
        city: z.city,
        folder: z.folder,
        pointsCount: z.coordinates.length,
        center: {
          lat: (z.bbox.minLat + z.bbox.maxLat) / 2,
          lng: (z.bbox.minLng + z.bbox.maxLng) / 2,
        },
        bbox: z.bbox,
      }));
      res.json({ data: zones });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/coverage/check - Consultar cobertura por lat/lng, url o texto
  router.post("/api/coverage/check", async (req, res, next) => {
    try {
      const { lat, lng, address, text, locationUrl } = req.body ?? {};
      const result = coverageService.checkLocation({
        lat: typeof lat === "number" ? lat : undefined,
        lng: typeof lng === "number" ? lng : undefined,
        text: typeof address === "string" ? address : typeof text === "string" ? text : undefined,
        locationUrl: typeof locationUrl === "string" ? locationUrl : undefined,
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/admin/coverage/import-kml - Subir e importar nuevo archivo KML (rol admin)
  router.post(
    "/api/admin/coverage/import-kml",
    upload.single("file"),
    async (req, res, next) => {
      try {
        requireRole(req, ["admin"]);

        let kmlContent: string | undefined;

        if (req.file?.buffer) {
          kmlContent = extractKmlFromBuffer(req.file.buffer);
        } else if (typeof req.body?.kml === "string") {
          kmlContent = req.body.kml;
        }

        if (!kmlContent) {
          res.status(400).json({
            error: {
              type: "VALIDATION_ERROR",
              message: "Debe adjuntar un archivo KML ('file') o enviar el contenido XML en 'kml'",
            },
          });
          return;
        }

        const result = await coverageService.importKml(kmlContent);
        res.status(200).json({
          data: {
            message: `Se importaron exitosamente ${result.importedCount} zonas de cobertura`,
            importedCount: result.importedCount,
            zones: result.zones.map((z) => ({ name: z.name, city: z.city, folder: z.folder })),
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  // POST /api/admin/coverage/reload - Forzar recarga de memoria desde PostgreSQL (rol admin)
  router.post("/api/admin/coverage/reload", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      await coverageService.reload();
      res.json({
        data: {
          success: true,
          count: coverageService.getZones().length,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
