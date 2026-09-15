import { Router } from "express";
import type Redis from "ioredis";
import type { Env } from "../../../../shared/config/env";
import { verifyZernioSignature } from "../../../../shared/http/zernio-signature";
import { enqueueConversationJob } from "../../../../shared/queue/redis";
import type { ReceiveInboundMessageUseCase } from "../application/use-cases/receive-inbound-message.use-case";
import { parseZernioWebhookPayload } from "../infrastructure/zernio/parse-zernio-webhook";
import type { ZernioSenderHttp } from "../infrastructure/zernio/zernio-sender.http";

import type { CampaignRecipientRepositoryPort } from "../../campaigns/application/ports/campaign-recipient.repository.port";
import type { CampaignRepositoryPort } from "../../campaigns/application/ports/campaign.repository.port";

export type ZernioWebhookRouterDeps = {
  env: Env;
  receiveInboundMessage: ReceiveInboundMessageUseCase;
  redisClient: Redis;
  zernioSender?: ZernioSenderHttp;
  recipientRepo?: CampaignRecipientRepositoryPort;
  campaignRepo?: CampaignRepositoryPort;
};

/**
 * Endpoint receptor de Webhooks de Zernio (docs/spec/00_OVERVIEW.md regla #1).
 * Responde 200 inmediatamente tras persistir cada mensaje crudo (regla #3);
 * el debounce y procesamiento por IA se encola para el worker asincrono.
 */
export function createZernioWebhookRouter(deps: ZernioWebhookRouterDeps): Router {
  const router = Router();
  const { env, receiveInboundMessage, redisClient, zernioSender, recipientRepo, campaignRepo } = deps;

  router.get("/api/webhooks/zernio", (_req, res) => {
    res.status(200).json({
      status: "active",
      provider: "zernio",
      endpoint: "/api/webhooks/zernio",
    });
  });

  router.post("/api/webhooks/zernio", async (req, res, next) => {
    try {
      req.log?.info({ path: req.path }, "webhook zernio POST");

      const signatureHeader =
        (req.header("x-zernio-signature") || req.header("x-late-signature"))?.trim();
      const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

      const signatureValid = verifyZernioSignature(
        rawBody,
        signatureHeader,
        env.ZERNIO_WEBHOOK_SECRET,
      );

      if (!signatureValid) {
        req.log?.warn({ signatureHeader }, "firma de webhook de zernio invalida");
        res.sendStatus(401);
        return;
      }

      // Si el payload incluye el conversationId de Zernio, enriquecemos el cache del sender
      const convId = req.body?.message?.conversationId;
      const rawSender = req.body?.message?.sender?.id || req.body?.message?.participantId;
      if (convId && rawSender && zernioSender) {
        zernioSender.registerConversation(String(rawSender), String(convId));
      }

      // Procesar eventos de estado de entrega de mensajes (failures / undelivered)
      const eventName = String(req.body?.event || "").toLowerCase();
      const messageObj = req.body?.message ?? req.body?.data ?? req.body;
      const statusRaw = String(messageObj?.status || req.body?.status || "").toLowerCase();

      const isFailureEvent =
        statusRaw.includes("fail") ||
        statusRaw.includes("undeliver") ||
        statusRaw.includes("reject") ||
        eventName.includes("failed") ||
        eventName.includes("rejected");

      if (isFailureEvent && recipientRepo && campaignRepo) {
        const platformMessageId =
          messageObj?.platformMessageId ||
          messageObj?.id ||
          req.body?.platformMessageId ||
          req.body?.messageId ||
          req.body?.id;

        const errorMessage =
          messageObj?.error?.message ||
          messageObj?.errorMessage ||
          req.body?.error ||
          "Error de entrega en WhatsApp / Meta (Fallo registrado en Zernio)";

        if (platformMessageId) {
          const updatedRecipient = await recipientRepo.updateStatusByExternalId(
            String(platformMessageId),
            "FAILED",
            { errorMessage: String(errorMessage) },
          );

          if (updatedRecipient) {
            await campaignRepo.incrementCounters(updatedRecipient.campaignId, { sent: -1, failed: 1 });
            req.log?.info(
              { platformMessageId, campaignId: updatedRecipient.campaignId, phone: updatedRecipient.phone },
              "Destinatario de campaña actualizado a FAILED desde webhook de Zernio",
            );
          }
        }
      }

      const normalizedMessages = parseZernioWebhookPayload(req.body);
      req.log?.info({ messageCount: normalizedMessages.length }, "payload de zernio normalizado");

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

      res.status(200).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
