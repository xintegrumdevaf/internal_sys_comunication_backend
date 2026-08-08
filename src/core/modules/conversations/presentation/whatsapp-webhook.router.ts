import { Router } from "express";
import type Redis from "ioredis";
import type { Env } from "../../../../shared/config/env";
import { verifyWhatsAppSignature } from "../../../../shared/http/whatsapp-signature";
import { enqueueConversationJob } from "../../../../shared/queue/redis";
import type { ReceiveInboundMessageUseCase } from "../application/use-cases/receive-inbound-message.use-case";
import { parseWhatsAppWebhookPayload } from "../infrastructure/whatsapp/parse-whatsapp-webhook";

export type WhatsAppWebhookRouterDeps = {
  env: Env;
  receiveInboundMessage: ReceiveInboundMessageUseCase;
  redisClient: Redis;
};

/**
 * Unico punto de entrada de WhatsApp (docs/spec/00_OVERVIEW.md regla #1).
 * Responde 200 inmediatamente tras persistir cada mensaje crudo (regla #3);
 * el procesamiento de IA se encola para un worker asincrono (Etapa 2+).
 */
export function createWhatsAppWebhookRouter(deps: WhatsAppWebhookRouterDeps): Router {
  const router = Router();
  const { env, receiveInboundMessage, redisClient } = deps;

  router.get("/api/webhooks/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(String(challenge ?? ""));
      return;
    }
    res.sendStatus(403);
  });

  router.post("/api/webhooks/whatsapp", async (req, res, next) => {
    try {
      const signatureHeader = req.header("x-hub-signature-256");
      const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      const signatureValid = verifyWhatsAppSignature(rawBody, signatureHeader, env.WHATSAPP_APP_SECRET);

      if (!signatureValid) {
        req.log?.warn("firma de webhook de whatsapp invalida");
        res.sendStatus(401);
        return;
      }

      const normalizedMessages = parseWhatsAppWebhookPayload(req.body);

      for (const normalized of normalizedMessages) {
        const { conversation, message, isDuplicate } = await receiveInboundMessage.execute(normalized);

        if (!isDuplicate) {
          await enqueueConversationJob(redisClient, conversation.id, {
            type: "MESSAGE_RECEIVED",
            conversationId: conversation.id,
            messageId: message.id,
          });
        }
      }

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
