import type { MessageTemplateRepositoryPort } from "../../message-templates/application/ports/message-template.repository.port";

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

      try {
        let result: { externalId: string };
        if (campaign.templateName) {
          let params = recipient.name ? [recipient.name] : [];

          if (this.messageTemplateRepo) {
            const tpl = await this.messageTemplateRepo.findByName(campaign.templateName);
            if (tpl) {
              const matches = (tpl.bodyText || "").match(/\{\{\s*\d+\s*\}\}/g);
              const expectedCount = matches ? new Set(matches).size : 0;
              if (expectedCount === 0) {
                params = [];
              } else if (expectedCount === 1) {
                params = [recipient.name ?? ""];
              } else if (expectedCount > 1) {
                params = [recipient.name ?? "", recipient.phone];
                while (params.length < expectedCount) {
                  params.push("");
                }
                params = params.slice(0, expectedCount);
              }
            }
          }

          result = await this.whatsAppSender.sendTemplate(
            recipient.phone,
            campaign.templateName,
            campaign.templateLanguage || "es",
            params,
          );
        } else {
          const finalBody = this.interpolateMessage(campaign, recipient);
          result = await this.whatsAppSender.sendText(recipient.phone, finalBody);
        }

        await this.recipientRepo.updateStatus(recipient.id, "SENT", {
          externalId: result.externalId,
          sentAt: new Date(),
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

    if (campaign.contactEnrichment?.additionalFields) {
      for (const [key, val] of Object.entries(campaign.contactEnrichment.additionalFields)) {
        const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");
        text = text.replace(regex, val);
      }
    }

    return text;
  }
}
