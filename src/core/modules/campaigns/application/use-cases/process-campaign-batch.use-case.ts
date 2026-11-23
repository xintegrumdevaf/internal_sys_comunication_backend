import type { Logger } from "../../../../../shared/logging/logger";
import type { WhatsAppSenderPort } from "../../../conversations/application/ports/whatsapp-sender.port";
import type { MessageTemplateRepositoryPort } from "../../../message-templates/application/ports/message-template.repository.port";
import type { CampaignRecipient } from "../../domain/campaign-recipient.entity";
import type { Campaign } from "../../domain/campaign.entity";
import type { CampaignRecipientRepositoryPort } from "../ports/campaign-recipient.repository.port";
import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";
import type { ConversationStatus } from "../../../conversations/domain/conversation.entity";
import { translateDeliveryError } from "../../../conversations/domain/meta-delivery-error";

export type ProcessBatchResult = {
  finished: boolean;
  processedCount: number;
  stoppedReason?: string;
};

export const MAX_RECIPIENT_RETRIES = 3;

export function isTransientCampaignError(error: unknown): boolean {
  if (!error) return false;
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  // Rate limit / Too Many Requests / Meta QPS limit
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
    return true;
  }
  // Server errors (5xx)
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("internal server error") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout")
  ) {
    return true;
  }
  // Network / Connection glitches / Timeouts
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("network error")
  ) {
    return true;
  }

  return false;
}

export function calculateCampaignBackoffMs(
  retryCount: number,
  baseDelayMs = 2000,
  maxDelayMs = 30000,
): number {
  const exponent = Math.max(0, retryCount - 1);
  const rawDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exponent));
  const jitter = Math.floor(Math.random() * 500);
  return rawDelay + jitter;
}

export class ProcessCampaignBatchUseCase {
  constructor(
    private readonly campaignRepo: CampaignRepositoryPort,
    private readonly recipientRepo: CampaignRecipientRepositoryPort,
    private readonly whatsAppSender: WhatsAppSenderPort,
    private readonly logger: Logger,
    private readonly messageTemplateRepo?: MessageTemplateRepositoryPort,
    private readonly conversationRepo?: ConversationRepositoryPort,
    private readonly messageRepo?: MessageRepositoryPort,
  ) {}

  async execute(campaignId: string, batchSize = 10): Promise<ProcessBatchResult> {
    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) {
      return { finished: true, processedCount: 0, stoppedReason: "Campaña no encontrada" };
    }

    if (campaign.status !== "RUNNING") {
      return {
        finished: true,
        processedCount: 0,
        stoppedReason: `Campaña no está en estado RUNNING (estado actual: ${campaign.status})`,
      };
    }

    const pendingRecipients = await this.recipientRepo.findPendingBatch(campaignId, batchSize);

    if (pendingRecipients.length === 0) {
      const counts = await this.recipientRepo.countByCampaign(campaignId);
      if (counts.pending === 0) {
        await this.campaignRepo.updateStatus(campaignId, "COMPLETED", {
          completedAt: new Date(),
        });
        this.logger.info({ campaignId }, "Campaña completada exitosamente, todos los destinatarios procesados");
        return { finished: true, processedCount: 0 };
      }
      return { finished: false, processedCount: 0 };
    }

    let processedCount = 0;

    for (const recipient of pendingRecipients) {
      // Re-verificar estado de la campaña antes de procesar cada destinatario
      const currentCampaign = await this.campaignRepo.findById(campaignId);
      if (!currentCampaign || currentCampaign.status !== "RUNNING") {
        this.logger.info(
          { campaignId, currentStatus: currentCampaign?.status },
          "Procesamiento de campaña detenido por cambio de estado",
        );
        return {
          finished: false,
          processedCount,
          stoppedReason: `Detenido por estado de campaña: ${currentCampaign?.status}`,
        };
      }

      let finalSentBody: string | undefined;
      try {
        let result: { externalId: string };

        if (campaign.templateName) {
          let params: string[] = [];
          let expectedCount = -1;
          let templateBodyText: string | undefined;

          if (this.messageTemplateRepo) {
            const tpl = await this.messageTemplateRepo.findByName(campaign.templateName);
            if (tpl) {
              templateBodyText = tpl.bodyText || "";
              const matches = templateBodyText.match(/\{\{\s*\d+\s*\}\}/g);
              expectedCount = matches ? new Set(matches).size : 0;
            }
          }

          if (expectedCount > 0) {
            params = this.resolveTemplateParams(campaign, recipient, expectedCount);
          } else if (expectedCount === 0) {
            params = [];
          } else {
            // expectedCount === -1 (messageTemplateRepo not provided)
            const mapKeys = campaign.variableMapping ? Object.keys(campaign.variableMapping) : [];
            if (mapKeys.length > 0) {
              params = this.resolveTemplateParams(campaign, recipient, mapKeys.length);
            } else {
              params = recipient.name ? [recipient.name] : [];
            }
          }

          if (templateBodyText) {
            let interpolated = templateBodyText;
            params.forEach((val, idx) => {
              interpolated = interpolated.replace(new RegExp(`\\{\\{\\s*${idx + 1}\\s*\\}\\}`, "g"), val);
            });
            finalSentBody = interpolated;
          }

          result = await this.whatsAppSender.sendTemplate(
            recipient.phone,
            campaign.templateName,
            campaign.templateLanguage || "es",
            params,
          );
        } else {
          finalSentBody = this.interpolateMessage(campaign, recipient);
          result = await this.whatsAppSender.sendText(recipient.phone, finalSentBody);
        }

        await this.recipientRepo.updateStatus(recipient.id, "SENT", {
          externalId: result.externalId,
          sentAt: new Date(),
          customBody: finalSentBody ?? recipient.customBody,
        });
        await this.campaignRepo.incrementCounters(campaignId, { sent: 1 });
        this.logger.info(
          { campaignId, recipientId: recipient.id, phone: recipient.phone, externalId: result.externalId },
          "Mensaje de campaña enviado exitosamente",
        );

        if (this.conversationRepo) {
          try {
            const conv = await this.conversationRepo.findOrCreateByWaPhone(recipient.phone);

            if (recipient.name && !conv.waProfileName) {
              await this.conversationRepo.setWaProfileName(conv.id, recipient.name);
            }

            if (this.messageRepo) {
              await this.messageRepo.insertOutbound({
                conversationId: conv.id,
                author: "agent",
                body: finalSentBody || (campaign.templateName ? `[Plantilla: ${campaign.templateName}]` : "[Campaña]"),
                externalId: result.externalId,
                status: "sent",
                caseId: conv.activeCaseId ?? undefined,
                caption: campaign.templateName ? `template:${campaign.templateName}` : undefined,
              });
            }

            // Aplicar chatRouting a la conversación (OPEN | PENDING | CLOSED)
            const routing = campaign.chatRouting;
            const rawStatus = (routing?.initialStatus ?? "CLOSED").toUpperCase();
            const targetStatus: ConversationStatus =
              rawStatus === "OPEN" ? "open" : rawStatus === "PENDING" ? "pending" : "closed";

            // Si el contacto ya tiene un caso activo o está siendo atendido (activeCaseId),
            // la campaña NO debe cerrar la conversación ni interrumpir al asesor, a menos que
            // forceChatUpdate sea explícitamente true.
            const hasActiveCase = Boolean(conv.activeCaseId);

            if (routing?.forceChatUpdate) {
              await this.conversationRepo.setStatus(conv.id, targetStatus);
            } else if (!hasActiveCase) {
              await this.conversationRepo.setStatus(conv.id, targetStatus);
            } else {
              this.logger.info(
                { conversationId: conv.id, activeCaseId: conv.activeCaseId, phone: recipient.phone, campaignId },
                "Mensaje de campaña enviado a contacto con caso activo: se preserva la atención y estado actual",
              );
            }
          } catch (convErr) {
            this.logger.warn(
              { err: convErr, phone: recipient.phone, campaignId },
              "No se pudo sincronizar la conversación para el destinatario de la campaña",
            );
          }
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const currentRetry = recipient.retryCount ?? 0;
        const isTransient = isTransientCampaignError(err);

        if (isTransient && currentRetry < MAX_RECIPIENT_RETRIES) {
          const nextRetry = currentRetry + 1;
          const backoffMs = calculateCampaignBackoffMs(nextRetry);
          const nextRetryAt = new Date(Date.now() + backoffMs);

          await this.recipientRepo.updateStatus(recipient.id, "PENDING", {
            errorMessage: `Reintento ${nextRetry}/${MAX_RECIPIENT_RETRIES}: ${errorMessage}`,
            customBody: finalSentBody ?? recipient.customBody,
            retryCount: nextRetry,
            nextRetryAt,
          });

          this.logger.warn(
            {
              campaignId,
              recipientId: recipient.id,
              phone: recipient.phone,
              retryCount: nextRetry,
              nextRetryAt,
              err: errorMessage,
            },
            `Fallo transitorio al enviar a destinatario; programado reintento #${nextRetry} en ${backoffMs}ms`,
          );
        } else {
          const translatedError = translateDeliveryError(errorMessage);
          await this.recipientRepo.updateStatus(recipient.id, "FAILED", {
            errorMessage: translatedError,
            customBody: finalSentBody ?? recipient.customBody,
            retryCount: currentRetry,
            nextRetryAt: null,
          });
          await this.campaignRepo.incrementCounters(campaignId, { failed: 1 });
          this.logger.error(
            { campaignId, recipientId: recipient.id, phone: recipient.phone, err },
            "Fallo permanente al enviar mensaje de campaña a destinatario individual",
          );
        }
      }

      processedCount++;

      // Si quickMode está activo y no es el último elemento del lote, aplicar el intervalo
      if (campaign.quickMode && campaign.quickModeIntervalSeconds > 0) {
        const delayMs = campaign.quickModeIntervalSeconds * 1000;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // Verificar si quedan más pendientes
    const updatedCounts = await this.recipientRepo.countByCampaign(campaignId);
    if (updatedCounts.pending === 0) {
      await this.campaignRepo.updateStatus(campaignId, "COMPLETED", {
        completedAt: new Date(),
      });
      return { finished: true, processedCount };
    }

    return { finished: false, processedCount };
  }

  private resolveTemplateParams(
    campaign: Campaign,
    recipient: CampaignRecipient,
    expectedCount: number,
  ): string[] {
    const params: string[] = [];
    const mapping = campaign.variableMapping || {};

    for (let i = 1; i <= expectedCount; i++) {
      let val: string | undefined;

      const mappedCol =
        mapping[String(i)] ||
        mapping[`{{${i}}}`] ||
        mapping[`${i}`] ||
        mapping[Object.keys(mapping)[i - 1] ?? ""];

      if (mappedCol) {
        const cleanCol = String(mappedCol).replace(/^columna:\s*/i, "").trim();
        val = this.getVariableFromRecipient(recipient, cleanCol);
      }

      if (val === undefined) {
        val =
          this.getVariableFromRecipient(recipient, String(i)) ??
          this.getVariableFromRecipient(recipient, `{{${i}}}`);
      }

      if (val === undefined) {
        const customVariables = this.getCustomVariablesFromRecipient(recipient);
        if (customVariables.length >= i) {
          val = customVariables[i - 1]?.value;
        }
      }

      if (val === undefined) {
        if (i === 1) {
          val = recipient.name ?? "";
        } else if (i === 2) {
          val = recipient.phone;
        } else {
          val = "";
        }
      }

      params.push(val);
    }

    return params;
  }

  private getCustomVariablesFromRecipient(recipient: CampaignRecipient): Array<{ key: string; value: string }> {
    if (!recipient.variables) return [];
    const ignored = new Set([
      "number",
      "telefono",
      "phone",
      "celular",
      "movil",
      "numero",
      "wa_phone",
      "tel",
      "name",
      "nombre",
      "contacto",
      "cliente",
      "body",
      "custombody",
      "mensaje",
      "message",
    ]);

    const result: Array<{ key: string; value: string }> = [];
    for (const [k, v] of Object.entries(recipient.variables)) {
      const cleanK = k.replace(/^columna:\s*/i, "").trim().toLowerCase();
      if (!cleanK || cleanK.startsWith("__empty") || ignored.has(cleanK)) {
        continue;
      }
      result.push({ key: k, value: String(v) });
    }

    return result;
  }

  private getVariableFromRecipient(recipient: CampaignRecipient, colName: string): string | undefined {
    if (!colName) return undefined;
    const target = colName.trim().toLowerCase();

    if (recipient.variables) {
      for (const [k, v] of Object.entries(recipient.variables)) {
        const cleanK = k.replace(/^columna:\s*/i, "").trim().toLowerCase();
        if (cleanK === target || k.trim().toLowerCase() === target) {
          return String(v);
        }
      }
    }

    if (target === "name" || target === "nombre") return recipient.name ?? undefined;
    if (target === "phone" || target === "telefono" || target === "number") return recipient.phone;
    if (target === "custombody" || target === "mensaje") return recipient.customBody ?? undefined;

    return undefined;
  }

  private interpolateMessage(campaign: Campaign, recipient: CampaignRecipient): string {
    if (recipient.customBody && recipient.customBody.trim().length > 0) {
      return recipient.customBody.trim();
    }

    let text = campaign.messageBody;
    text = text.replace(/\{\{\s*name\s*\}\}/gi, recipient.name ?? "");
    text = text.replace(/\{\{\s*nombre\s*\}\}/gi, recipient.name ?? "");
    text = text.replace(/\{\{\s*number\s*\}\}/gi, recipient.phone);
    text = text.replace(/\{\{\s*phone\s*\}\}/gi, recipient.phone);
    text = text.replace(/\{\{\s*telefono\s*\}\}/gi, recipient.phone);

    if (recipient.variables) {
      for (const [key, val] of Object.entries(recipient.variables)) {
        const cleanKey = key.replace(/^columna:\s*/i, "").trim();
        if (cleanKey) {
          const escapedKey = cleanKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          text = text.replace(new RegExp(`\\{\\{\\s*${escapedKey}\\s*\\}\\}`, "gi"), String(val));
          text = text.replace(new RegExp(`\\{\\{\\s*columna:\\s*${escapedKey}\\s*\\}\\}`, "gi"), String(val));
        }
      }
    }

    if (campaign.contactEnrichment?.additionalFields) {
      for (const [key, val] of Object.entries(campaign.contactEnrichment.additionalFields)) {
        const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");
        text = text.replace(regex, val);
      }
    }

    return text;
  }
}
