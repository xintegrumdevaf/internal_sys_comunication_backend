import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../../../../shared/http/require-auth";
import type { CreateCampaignUseCase } from "../application/use-cases/create-campaign.use-case";
import type { ImportCampaignRecipientsUseCase } from "../application/use-cases/import-campaign-recipients.use-case";
import type { StartCampaignUseCase } from "../application/use-cases/start-campaign.use-case";
import type { SuspendCampaignUseCase } from "../application/use-cases/suspend-campaign.use-case";
import type { ResumeCampaignUseCase } from "../application/use-cases/resume-campaign.use-case";
import type { ListCampaignsUseCase } from "../application/use-cases/list-campaigns.use-case";
import type { GetCampaignUseCase } from "../application/use-cases/get-campaign.use-case";
import type { DeleteCampaignUseCase } from "../application/use-cases/delete-campaign.use-case";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

export type CampaignsRouterDeps = {
  createCampaign: CreateCampaignUseCase;
  importRecipients: ImportCampaignRecipientsUseCase;
  startCampaign: StartCampaignUseCase;
  suspendCampaign: SuspendCampaignUseCase;
  resumeCampaign: ResumeCampaignUseCase;
  listCampaigns: ListCampaignsUseCase;
  getCampaign: GetCampaignUseCase;
  deleteCampaign: DeleteCampaignUseCase;
};

const createCampaignBodySchema = z.object({
  name: z.string().min(1).max(50),
  messageBody: z.string().optional(),
  quickMode: z.boolean().optional(),
  quickModeIntervalSeconds: z.number().int().positive().optional(),
  chatRouting: z
    .object({
      initialStatus: z.enum(["OPEN", "PENDING", "CLOSED"]).optional(),
      departmentId: z.string().nullable().optional(),
      assignedAgentId: z.string().nullable().optional(),
      keepAssignedToUser: z.boolean().optional(),
      delegateToBot: z.boolean().optional(),
      forceChatUpdate: z.boolean().optional(),
    })
    .optional(),
  contactEnrichment: z
    .object({
      tagIds: z.array(z.string()).optional(),
      additionalFields: z.record(z.string(), z.string()).optional(),
      forceUpdateContactData: z.boolean().optional(),
    })
    .optional(),
  templateName: z.string().nullable().optional(),
  templateLanguage: z.string().nullable().optional(),
});

const listFilterSchema = z.object({
  search: z.string().optional(),
  status: z
    .enum(["DRAFT", "RUNNING", "SUSPENDED", "COMPLETED", "FAILED"])
    .optional(),
});

export function createCampaignsRouter(deps: CampaignsRouterDeps): Router {
  const router = Router();

  // GET /api/campaigns - Listar campañas con filtros y progreso
  router.get("/api/campaigns", async (req, res, next) => {
    try {
      requireAuth(req);
      const filter = listFilterSchema.parse({
        search: req.query.search ? String(req.query.search) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
      });

      const data = await deps.listCampaigns.execute(filter);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/campaigns - Crear campaña en estado DRAFT
  router.post("/api/campaigns", async (req, res, next) => {
    try {
      requireAuth(req);
      const body = createCampaignBodySchema.parse(req.body);
      const data = await deps.createCampaign.execute(body);
      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/campaigns/:id - Detalle completo de campaña con destinatarios
  router.get("/api/campaigns/:id", async (req, res, next) => {
    try {
      requireAuth(req);
      const data = await deps.getCampaign.execute(req.params.id!);
      if (!data) {
        res.status(404).json({ error: "Campaña no encontrada" });
        return;
      }
      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/campaigns/:id/recipients/import - Importación de destinatarios (.csv o .xlsx)
  router.post(
    "/api/campaigns/:id/recipients/import",
    upload.any(),
    async (req, res, next) => {
      try {
        requireAuth(req);
        const file =
          req.file ||
          (req.files && Array.isArray(req.files) ? req.files[0] : undefined);

        if (!file?.buffer) {
          res
            .status(400)
            .json({ error: "Archivo de destinatarios (.csv o .xlsx) es requerido" });
          return;
        }

        const result = await deps.importRecipients.execute(
          req.params.id as string,
          file.buffer,
        );
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  // POST /api/campaigns/:id/start - Iniciar campaña
  router.post("/api/campaigns/:id/start", async (req, res, next) => {
    try {
      requireAuth(req);
      const campaign = await deps.startCampaign.execute(req.params.id!);
      res.json({
        success: true,
        message: "Campaña iniciada",
        status: campaign.status,
        data: campaign,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/campaigns/:id/suspend - Suspender campaña
  router.post("/api/campaigns/:id/suspend", async (req, res, next) => {
    try {
      requireAuth(req);
      const campaign = await deps.suspendCampaign.execute(req.params.id!);
      res.json({
        success: true,
        message: "Campaña suspendida",
        status: campaign.status,
        data: campaign,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/campaigns/:id/resume - Reanudar campaña
  router.post("/api/campaigns/:id/resume", async (req, res, next) => {
    try {
      requireAuth(req);
      const campaign = await deps.resumeCampaign.execute(req.params.id!);
      res.json({
        success: true,
        message: "Campaña reanudada",
        status: campaign.status,
        data: campaign,
      });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/campaigns/:id - Eliminar campaña (solo si status es DRAFT)
  router.delete("/api/campaigns/:id", async (req, res, next) => {
    try {
      requireAuth(req);
      const deleted = await deps.deleteCampaign.execute(req.params.id!);
      if (!deleted) {
        res.status(404).json({ error: "Campaña no encontrada" });
        return;
      }
      res.json({ success: true, message: "Campaña eliminada" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
