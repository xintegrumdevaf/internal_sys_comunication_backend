import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ListPromptsUseCase } from "../application/use-cases/list-prompts.use-case";
import type { GetPromptUseCase } from "../application/use-cases/get-prompt.use-case";
import type { SavePromptVersionUseCase } from "../application/use-cases/save-prompt-version.use-case";
import type { PublishPromptVersionUseCase } from "../application/use-cases/publish-prompt-version.use-case";
import type { RollbackPromptVersionUseCase } from "../application/use-cases/rollback-prompt-version.use-case";
import type { SimulatePromptUseCase } from "../application/use-cases/simulate-prompt.use-case";

const saveVersionSchema = z.object({
  systemPrompt: z.string().min(10, "El system prompt debe tener al menos 10 caracteres"),
  userTemplate: z.string().min(1, "El user template es obligatorio"),
  changeNotes: z.string().optional(),
  modelConfig: z.record(z.string(), z.unknown()).optional(),
  publishImmediately: z.boolean().optional(),
});

const publishSchema = z.object({
  versionId: z.string().uuid("ID de versión inválido"),
});

const rollbackSchema = z.object({
  targetVersionId: z.string().uuid("ID de versión inválido").optional(),
});

const simulateSchema = z.object({
  systemPrompt: z.string().optional(),
  userTemplate: z.string().optional(),
  testVariables: z.record(z.string(), z.unknown()).default({}),
  modelConfig: z
    .object({
      temperature: z.number().min(0).max(1).optional(),
      maxTokens: z.number().positive().optional(),
    })
    .optional(),
});

export interface PromptsRouterDeps {
  listPrompts: ListPromptsUseCase;
  getPrompt: GetPromptUseCase;
  saveVersion: SavePromptVersionUseCase;
  publishVersion: PublishPromptVersionUseCase;
  rollbackVersion: RollbackPromptVersionUseCase;
  simulatePrompt: SimulatePromptUseCase;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getErrorStatus(err: unknown, defaultStatus = 400): number {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return defaultStatus;
}

export function createPromptsRouter(deps: PromptsRouterDeps): Router {
  const router = Router();

  // Listar todas las plantillas
  router.get("/", async (_req: Request, res: Response): Promise<void> => {
    try {
      const templates = await deps.listPrompts.execute();
      res.json({ success: true, data: templates });
    } catch (err: unknown) {
      res.status(getErrorStatus(err, 500)).json({ success: false, error: getErrorMessage(err) });
    }
  });

  // Obtener detalle de una plantilla con sus versiones
  router.get("/:slug", async (req: Request, res: Response): Promise<void> => {
    try {
      const detail = await deps.getPrompt.execute(req.params.slug as string);
      res.json({ success: true, data: detail });
    } catch (err: unknown) {
      res.status(getErrorStatus(err, 500)).json({ success: false, error: getErrorMessage(err) });
    }
  });

  // Guardar nueva versión (borrador o publicar de una vez)
  router.post("/:slug/versions", async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = saveVersionSchema.parse(req.body);
      const agentId = req.agent?.id;
      const version = await deps.saveVersion.execute({
        slug: req.params.slug as string,
        systemPrompt: parsed.systemPrompt,
        userTemplate: parsed.userTemplate,
        modelConfig: parsed.modelConfig,
        changeNotes: parsed.changeNotes,
        createdBy: agentId,
        publishImmediately: parsed.publishImmediately,
      });
      res.status(201).json({ success: true, data: version });
    } catch (err: unknown) {
      res.status(getErrorStatus(err, 400)).json({ success: false, error: getErrorMessage(err) });
    }
  });

  // Publicar / activar una versión existente
  router.post("/:slug/publish", async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = publishSchema.parse(req.body);
      const version = await deps.publishVersion.execute({
        slug: req.params.slug as string,
        versionId: parsed.versionId,
      });
      res.json({ success: true, data: version });
    } catch (err: unknown) {
      res.status(getErrorStatus(err, 400)).json({ success: false, error: getErrorMessage(err) });
    }
  });

  // Rollback a versión anterior
  router.post("/:slug/rollback", async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = rollbackSchema.parse(req.body || {});
      const version = await deps.rollbackVersion.execute({
        slug: req.params.slug as string,
        targetVersionId: parsed.targetVersionId,
      });
      res.json({
        success: true,
        data: version,
        message: `Revertido a versión ${version.versionNumber}`,
      });
    } catch (err: unknown) {
      res.status(getErrorStatus(err, 400)).json({ success: false, error: getErrorMessage(err) });
    }
  });

  // Playground: Simular prompt en vivo
  router.post("/:slug/simulate", async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = simulateSchema.parse(req.body);
      const result = await deps.simulatePrompt.execute({
        slug: req.params.slug as string,
        systemPrompt: parsed.systemPrompt,
        userTemplate: parsed.userTemplate,
        testVariables: parsed.testVariables,
        modelConfig: parsed.modelConfig,
      });
      res.json({ success: true, data: result });
    } catch (err: unknown) {
      res.status(getErrorStatus(err, 400)).json({ success: false, error: getErrorMessage(err) });
    }
  });

  return router;
}
