import { Router } from "express";
import type { Logger } from "../../../../shared/logging/logger";
import type { HandleTelegramWebhookUseCase } from "../application/use-cases/handle-telegram-webhook.use-case";
import type { TelegramUpdate } from "../domain/telegram-message.types";

export interface TelegramRouterDeps {
  handleWebhookUseCase: HandleTelegramWebhookUseCase;
  logger: Logger;
}

export function createTelegramRouter(deps: TelegramRouterDeps): Router {
  const router = Router();
  const { handleWebhookUseCase, logger } = deps;

  /**
   * POST /api/v1/telegram/webhook
   * Endpoint público receptor de actualizaciones (Updates) enviadas por api.telegram.org.
   * Valida X-Telegram-Bot-Api-Secret-Token y responde 200 OK inmediatamente.
   */
  router.post("/api/v1/telegram/webhook", async (req, res) => {
    try {
      const secretTokenHeader = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
      const update = req.body as TelegramUpdate;

      const result = await handleWebhookUseCase.execute({
        update,
        secretTokenHeader,
      });

      logger.debug({ result, updateId: update?.update_id }, "webhook de Telegram procesado");
      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error({ err }, "error al procesar webhook entrante de Telegram");
      // Se retorna 200 para evitar que Telegram reintente en bucle infinito ante errores no recuperables
      res.status(200).json({ ok: false, error: err instanceof Error ? err.message : "Internal error" });
    }
  });

  return router;
}

