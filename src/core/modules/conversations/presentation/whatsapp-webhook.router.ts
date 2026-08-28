import { Router } from "express";
import type Redis from "ioredis";
import type { Env } from "../../../../shared/config/env";
import { verifyWhatsAppSignature } from "../../../../shared/http/whatsapp-signature";
import { enqueueConversationJob } from "../../../../shared/queue/redis";
import type { SyncTemplateStatusUseCase } from "../../message-templates/application/use-cases/sync-template-status.use-case";
import {
  parseWhatsAppWebhookPayload,
  parseWhatsAppTemplateStatusUpdates,
} from "../infrastructure/whatsapp/parse-whatsapp-webhook";

export type WhatsAppWebhookRouterDeps = {
  env: Env;
  receiveInboundMessage: ReceiveInboundMessageUseCase;
  redisClient: Redis;
  syncTemplateStatus?: SyncTemplateStatusUseCase;
};

/**
 * Unico punto de entrada de WhatsApp (docs/spec/00_OVERVIEW.md regla #1).
 * Responde 200 inmediatamente tras persistir cada mensaje crudo (regla #3);
 * el procesamiento de IA se encola para un worker asincrono (Etapa 2+).
 */
export function createWhatsAppWebhookRouter(deps: WhatsAppWebhookRouterDeps): Router {
  const router = Router();
  const { env, receiveInboundMessage, redisClient, syncTemplateStatus } = deps;

  router.get("/api/webhooks/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const modeMatches = mode === "subscribe";
    const tokenMatches = token === env.WHATSAPP_VERIFY_TOKEN;

    if (modeMatches && tokenMatches) {
      req.log?.info({ challengeProvided: challenge !== undefined }, "webhook de whatsapp verificado");
      res.status(200).send(String(challenge ?? ""));
      return;
    }

    req.log?.warn(
      {
        mode,
        modeMatches,
        verifyTokenProvided: typeof token === "string" && token.length > 0,
        verifyTokenMatches: tokenMatches,
        challengeProvided: challenge !== undefined,
      },
      "verificacion de webhook de whatsapp rechazada",
    );
    res.sendStatus(403);
  });

  router.post("/api/webhooks/whatsapp", async (req, res, next) => {
    try {
      req.log?.info({ path: req.path }, "webhook whatsapp POST");

      const signatureHeader = req.header("x-hub-signature-256");
      const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const signatureValid = verifyWhatsAppSignature(rawBody, signatureHeader, env.WHATSAPP_APP_SECRET);

      if (!signatureValid) {
        req.log?.warn("firma de webhook de whatsapp invalida");
        res.sendStatus(401);
        return;
      }

      const normalizedMessages = parseWhatsAppWebhookPayload(req.body);
      req.log?.info({ messageCount: normalizedMessages.length }, "payload de whatsapp recibido");

      for (const normalized of normalizedMessages) {
        const { conversation, message, isDuplicate } = await receiveInboundMessage.execute({
          ...normalized,
          correlationId: req.correlationId,
        });

        if (!isDuplicate) {
          await enqueueConversationJob(redisClient, conversation.id, {
            type: "MESSAGE_RECEIVED",
            conversationId: conversation.id,
            messageId: message.id,
          });
        }
      }

      const templateStatusUpdates = parseWhatsAppTemplateStatusUpdates(req.body);
      if (templateStatusUpdates.length > 0 && syncTemplateStatus) {
        for (const update of templateStatusUpdates) {
          try {
            await syncTemplateStatus.execute(update);
            req.log?.info(
              { metaTemplateId: update.metaTemplateId, name: update.name, status: update.status },
              "Plantilla actualizada desde webhook de Meta",
            );
          } catch (error) {
            req.log?.error({ err: error, update }, "Error al sincronizar estado de plantilla desde webhook");
          }
        }
      }

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
