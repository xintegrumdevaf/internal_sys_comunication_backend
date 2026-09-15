import type { Logger } from "../../../../../shared/logging/logger";
import type { WhatsAppSenderPort } from "../../../conversations/application/ports/whatsapp-sender.port";
import type { MessageTemplateRepositoryPort } from "../../../message-templates/application/ports/message-template.repository.port";
import type { CampaignRecipient } from "../../domain/campaign-recipient.entity";
import type { Campaign } from "../../domain/campaign.entity";
import type { CampaignRecipientRepositoryPort } from "../ports/campaign-recipient.repository.port";
import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";

export type ProcessBatchResult = {
  finished: boolean;
  processedCount: number;
  stoppedReason?: string;
};

export class ProcessCampaignBatchUseCase {
  constructor(
    private readonly campaignRepo: CampaignRepositoryPort,
    private readonly recipientRepo: CampaignRecipientRepositoryPort,
    private readonly whatsAppSender: WhatsAppSenderPort,
    private readonly logger: Logger,
    private readonly messageTemplateRepo?: MessageTemplateRepositoryPort,
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
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.recipientRepo.updateStatus(recipient.id, "FAILED", {
          errorMessage,
          customBody: finalSentBody ?? recipient.customBody,
        });
        await this.campaignRepo.incrementCounters(campaignId, { failed: 1 });
        this.logger.error(
          { campaignId, recipientId: recipient.id, phone: recipient.phone, err },
          "Fallo al enviar mensaje de campaña a destinatario individual",
        );
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
