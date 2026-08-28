import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../../../shared/http/require-auth";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { CreateMessageTemplateUseCase } from "../application/use-cases/create-message-template.use-case";
import type { ListMessageTemplatesUseCase } from "../application/use-cases/list-message-templates.use-case";
import type { DeleteMessageTemplateUseCase } from "../application/use-cases/delete-message-template.use-case";
import type { SyncTemplateStatusUseCase } from "../application/use-cases/sync-template-status.use-case";
import type { MessageTemplateRepositoryPort } from "../application/ports/message-template.repository.port";

export type MessageTemplatesRouterDeps = {
  createTemplate: CreateMessageTemplateUseCase;
  listTemplates: ListMessageTemplatesUseCase;
  deleteTemplate: DeleteMessageTemplateUseCase;
  syncTemplateStatus: SyncTemplateStatusUseCase;
  templateRepo: MessageTemplateRepositoryPort;
};

const createTemplateBodySchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z0-9_]+$/,
      "El nombre de la plantilla solo debe contener letras minúsculas, números y guiones bajos (^[a-z0-9_]+$)",
    ),
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
  language: z.string().optional(),
  headerType: z.enum(["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"]).optional(),
  headerContent: z.string().nullable().optional(),
  bodyText: z.string().min(1).max(1024),
  footerText: z.string().nullable().optional(),
  buttons: z
    .array(
      z.object({
        type: z.enum(["QUICK_REPLY", "URL", "PHONE_NUMBER"]),
        text: z.string(),
        url: z.string().optional(),
        phoneNumber: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
});

const listQuerySchema = z.object({
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const syncStatusBodySchema = z.object({
  id: z.string().optional(),
  metaTemplateId: z.string().optional(),
  name: z.string().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"]).optional(),
  rejectedReason: z.string().nullable().optional(),
});

function handleZodOrNext(error: unknown, next: (err?: unknown) => void) {
  if (
    error instanceof z.ZodError ||
    (error && typeof error === "object" && (error as { name?: string }).name === "ZodError")
  ) {
    const zodErr = error as z.ZodError;
    const msg = zodErr.issues
      ? zodErr.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
      : "Error de validación";
    next(validationError(msg));
    return;
  }
  next(error);
}

export function createMessageTemplatesRouter(deps: MessageTemplatesRouterDeps): Router {
  const router = Router();

  router.get("/api/message-templates", async (req, res, next) => {
    try {
      requireAuth(req);
      const query = listQuerySchema.parse(req.query);
      const data = await deps.listTemplates.execute(query);
      res.json({ data });
    } catch (error) {
      handleZodOrNext(error, next);
    }
  });

  router.post("/api/message-templates", async (req, res, next) => {
    try {
      requireAuth(req);
      const body = createTemplateBodySchema.parse(req.body);
      const data = await deps.createTemplate.execute(body);
      res.status(201).json({ data });
    } catch (error) {
      handleZodOrNext(error, next);
    }
  });

  router.get("/api/message-templates/:id", async (req, res, next) => {
    try {
      requireAuth(req);
      const template = await deps.templateRepo.findById(req.params.id!);
      if (!template) {
        res.status(404).json({ error: { message: "Plantilla no encontrada", code: "NOT_FOUND" } });
        return;
      }
      res.json({ data: template });
    } catch (error) {
      handleZodOrNext(error, next);
    }
  });

  router.delete("/api/message-templates/:id", async (req, res, next) => {
    try {
      requireAuth(req);
      const result = await deps.deleteTemplate.execute(req.params.id!);
      res.json({ data: result });
    } catch (error) {
      handleZodOrNext(error, next);
    }
  });

  router.post("/api/message-templates/sync-all", async (req, res, next) => {
    try {
      requireAuth(req);
      const templates = await deps.templateRepo.list({});
      const pending = templates.items.filter((t) => t.status === "PENDING" && t.metaTemplateId);
      const updatedList = [];
      for (const t of pending) {
        try {
          const updated = await deps.syncTemplateStatus.execute({ id: t.id });
          updatedList.push(updated);
        } catch (_) {}
      }
      res.json({ data: updatedList, syncedCount: updatedList.length });
    } catch (error) {
      handleZodOrNext(error, next);
    }
  });

  router.post("/api/message-templates/:id/sync", async (req, res, next) => {
    try {
      requireAuth(req);
      const updated = await deps.syncTemplateStatus.execute({ id: req.params.id! });
      res.json({ data: updated });
    } catch (error) {
      handleZodOrNext(error, next);
    }
  });

  router.post("/webhooks/whatsapp/template-status", async (req, res, next) => {
    try {
      requireAuth(req);
      const body = syncStatusBodySchema.parse(req.body);
      const updated = await deps.syncTemplateStatus.execute(body);
      res.json({ data: updated });
    } catch (error) {
      handleZodOrNext(error, next);
    }
  });

  return router;
}
