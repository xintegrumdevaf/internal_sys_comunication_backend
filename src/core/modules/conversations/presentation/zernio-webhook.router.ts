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
import type { MessageRepositoryPort } from "../application/ports/message.repository.port";
import type { RealtimeBroadcaster } from "../../realtime/application/realtime-broadcaster";
import type { MessageStatus } from "../domain/message.entity";

export type ZernioWebhookRouterDeps = {
  env: Env;
  receiveInboundMessage: ReceiveInboundMessageUseCase;
  redisClient: Redis;
  zernioSender?: ZernioSenderHttp;
  recipientRepo?: CampaignRecipientRepositoryPort;
  campaignRepo?: CampaignRepositoryPort;
  messageRepo?: MessageRepositoryPort;
  broadcaster?: RealtimeBroadcaster;
  conversationRepo?: import("../application/ports/conversation.repository.port").ConversationRepositoryPort;
};

/**
 * Endpoint receptor de Webhooks de Zernio (docs/spec/00_OVERVIEW.md regla #1).
 * Responde 200 inmediatamente tras persistir cada mensaje crudo (regla #3);
 * el debounce y procesamiento por IA se encola para el worker asincrono.
 */
export function createZernioWebhookRouter(deps: ZernioWebhookRouterDeps): Router {
  const router = Router();
  const {
    env,
    receiveInboundMessage,
    redisClient,
    zernioSender,
    recipientRepo,
    campaignRepo,
    messageRepo,
    broadcaster,
    conversationRepo,
  } = deps;

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
      const msgObj = req.body?.message;
      const isOutboundMsg = msgObj?.direction === "outgoing" || msgObj?.fromMe === true;
      const rawParticipant = isOutboundMsg
        ? msgObj?.recipient?.id || msgObj?.recipient?.username || msgObj?.participantId
        : msgObj?.sender?.id || msgObj?.sender?.username || msgObj?.participantId;

      if (convId && rawParticipant && zernioSender) {
        zernioSender.registerConversation(String(rawParticipant), String(convId));
      }

      // Procesar eventos de estado de entrega de mensajes (failures / undelivered / delivered / read)
      const eventName = String(req.body?.event || "").toLowerCase();
      const messageObj = req.body?.message ?? req.body?.data ?? req.body;
      const statusRaw = String(
        messageObj?.deliveryStatus ||
          messageObj?.delivery_status ||
          messageObj?.status ||
          req.body?.deliveryStatus ||
          req.body?.status ||
          "",
      ).toLowerCase();

      const isFailureEvent =
        statusRaw.includes("fail") ||
        statusRaw.includes("undeliver") ||
        statusRaw.includes("reject") ||
        eventName.includes("failed") ||
        eventName.includes("rejected") ||
        Boolean(messageObj?.deliveryError || messageObj?.error || req.body?.deliveryError || req.body?.error);

      const platformMessageId =
        messageObj?.platformMessageId ||
        messageObj?.id ||
        req.body?.platformMessageId ||
        req.body?.messageId ||
        req.body?.id;

      if (isFailureEvent && recipientRepo && campaignRepo && platformMessageId) {
        const errorMessage =
          messageObj?.error?.message ||
          messageObj?.errorMessage ||
          req.body?.error ||
          "Error de entrega en WhatsApp / Meta (Fallo registrado en Zernio)";

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

      // Actualizar estado en la tabla de mensajes de conversación
      if (platformMessageId && messageRepo) {
        let newStatus: MessageStatus = "sent";
        let errorMessage: string | null = null;

        if (isFailureEvent) {
          newStatus = "failed";
          errorMessage =
            messageObj?.error?.message ||
            messageObj?.errorMessage ||
            req.body?.error ||
            "Error de entrega en WhatsApp / Meta (Fallo registrado en Zernio)";
        } else if (statusRaw.includes("read") || eventName.includes("read")) {
          newStatus = "read";
        } else if (
          statusRaw.includes("deliver") ||
          eventName.includes("delivered") ||
          statusRaw === "sent"
        ) {
          newStatus = statusRaw.includes("deliver") || eventName.includes("delivered")
            ? "delivered"
            : "sent";
        }

        if (isFailureEvent || newStatus !== "sent") {
          let updatedMsg = await messageRepo.updateStatusByExternalId(
            String(platformMessageId),
            newStatus,
            errorMessage,
          );

          if (!updatedMsg && messageObj?.id && String(messageObj.id) !== String(platformMessageId)) {
            updatedMsg = await messageRepo.updateStatusByExternalId(
              String(messageObj.id),
              newStatus,
              errorMessage,
            );
          }

          if (!updatedMsg && rawParticipant && conversationRepo) {
            const conv = await conversationRepo.findByWaPhone(String(rawParticipant));
            if (conv) {
              const matchedOutbound = await messageRepo.findRecentOutbound(conv.id, {
                externalId: String(platformMessageId),
                body: messageObj?.text,
                maxAgeSeconds: 120,
              });
              if (matchedOutbound) {
                if (platformMessageId && matchedOutbound.externalId !== String(platformMessageId)) {
                  await messageRepo.updateExternalId(matchedOutbound.id, String(platformMessageId));
                }
                updatedMsg = await messageRepo.updateStatusByExternalId(
                  String(platformMessageId),
                  newStatus,
                  errorMessage,
                );
              }
            }
          }

          if (updatedMsg) {
            req.log?.info(
              { platformMessageId, messageId: updatedMsg.id, status: newStatus },
              "Estado de mensaje de conversación actualizado desde webhook de Zernio",
            );

            if (broadcaster) {
              broadcaster.publish({
                type: "MESSAGE_STATUS_UPDATED",
                conversationId: updatedMsg.conversationId,
                messageId: updatedMsg.id,
                status: newStatus,
                errorMessage,
              });
            }
          }
        }
      }

      // Si el evento fue estrictamente una notificación de estado / entrega de un mensaje saliente,
      // no debemos proceder a insertarlo como un mensaje nuevo en la conversación.
      const isDeliveryReceiptEvent =
        eventName === "message.delivered" ||
        eventName === "message.read" ||
        eventName.startsWith("message.delivery");

      if (isDeliveryReceiptEvent) {
        req.log?.info({ event: eventName, platformMessageId }, "evento de recibo de entrega procesado sin re-insertar");
        res.status(200).json({ ok: true, status: "delivery_receipt_handled" });
        return;
      }

      const normalizedMessages = await parseZernioWebhookPayload(req.body, { zernioSender });
      req.log?.info({ messageCount: normalizedMessages.length }, "payload de zernio normalizado");

      for (const normalized of normalizedMessages) {
        if (normalized.direction === "outbound") {
          // Desduplicación de ecos salientes generados por nuestra propia API o IA
          const existingConv = conversationRepo
            ? await conversationRepo.findByWaPhone(normalized.waPhone)
            : null;
          if (existingConv && messageRepo) {
            const matchedOutbound = await messageRepo.findRecentOutbound(existingConv.id, {
              externalId: normalized.externalId,
              body: normalized.body,
              maxAgeSeconds: 60,
            });

            if (matchedOutbound) {
              req.log?.info(
                { conversationId: existingConv.id, messageId: matchedOutbound.id, externalId: normalized.externalId },
                "eco saliente de Zernio reconocido como mensaje local existente; correlacionando sin duplicar",
              );

              if (normalized.externalId && matchedOutbound.externalId !== normalized.externalId) {
                await messageRepo.updateExternalId(matchedOutbound.id, normalized.externalId);
              }
              await messageRepo.updateStatusByExternalId(normalized.externalId, "delivered");
              if (broadcaster) {
                broadcaster.publish({
                  type: "MESSAGE_STATUS_UPDATED",
                  conversationId: existingConv.id,
                  messageId: matchedOutbound.id,
                  status: "delivered",
                });
              }
              continue; // Evita crear fila duplicada en la base de datos
            }
          }
        }

        const { conversation, message, isDuplicate } = await receiveInboundMessage.execute({
          ...normalized,
          correlationId: req.correlationId,
        });

        if (!isDuplicate && normalized.direction !== "outbound") {
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
