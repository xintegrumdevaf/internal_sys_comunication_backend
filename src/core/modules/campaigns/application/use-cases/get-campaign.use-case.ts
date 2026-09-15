import type { Campaign } from "../../domain/campaign.entity";
import type { CampaignRecipient } from "../../domain/campaign-recipient.entity";
import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";
import type { CampaignRecipientRepositoryPort } from "../ports/campaign-recipient.repository.port";
import type { WhatsAppSenderPort } from "../../../conversations/application/ports/whatsapp-sender.port";
import type { MessageTemplateRepositoryPort } from "../../../message-templates/application/ports/message-template.repository.port";

export type CampaignDetail = Campaign & {
  progress: number;
  recipients: CampaignRecipient[];
};

export function interpolateRecipientBody(
  campaign: Campaign,
  recipient: CampaignRecipient,
  templateBodyText?: string,
): string {
  if (recipient.customBody && recipient.customBody.trim().length > 0) {
    return recipient.customBody.trim();
  }

  let text = templateBodyText || campaign.messageBody || "";
  if (!text) return "";

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

  const mapping = campaign.variableMapping || {};
  const posKeys = Object.keys(mapping);
  if (posKeys.length > 0) {
    posKeys.forEach((posKey, idx) => {
      const posNum = posKey.replace(/\D/g, "") || String(idx + 1);
      const mappedCol = mapping[posKey];
      if (mappedCol) {
        const cleanCol = String(mappedCol).replace(/^columna:\s*/i, "").trim();
        const val =
          recipient.variables?.[cleanCol] ||
          recipient.variables?.[mappedCol] ||
          recipient.variables?.[`columna: ${cleanCol}`] ||
          "";
        text = text.replace(new RegExp(`\\{\\{\\s*${posNum}\\s*\\}\\}`, "g"), String(val));
      }
    });
  }

  return text.trim();
}

export class GetCampaignUseCase {
  constructor(
    private readonly campaignRepo: CampaignRepositoryPort,
    private readonly recipientRepo: CampaignRecipientRepositoryPort,
    private readonly whatsAppSender?: WhatsAppSenderPort,
    private readonly messageTemplateRepo?: MessageTemplateRepositoryPort,
  ) {}

  async execute(id: string): Promise<CampaignDetail | null> {
    const campaign = await this.campaignRepo.findById(id);
    if (!campaign) return null;

    let recipients = await this.recipientRepo.listByCampaignId(id);

    let templateBodyText: string | undefined;
    if (campaign.templateName && this.messageTemplateRepo) {
      const tpl = await this.messageTemplateRepo.findByName(campaign.templateName);
      if (tpl) {
        templateBodyText = tpl.bodyText || undefined;
      }
    }

    if (this.whatsAppSender?.checkMessageStatus) {
      let stateChanged = false;
      for (const r of recipients) {
        const renderedBody = interpolateRecipientBody(campaign, r, templateBodyText);
        if (r.status === "SENT" && r.externalId) {
          const check = await this.whatsAppSender.checkMessageStatus(r.phone, r.externalId);
          if (check && check.status === "failed") {
            await this.recipientRepo.updateStatus(r.id, "FAILED", {
              errorMessage: check.errorMessage ?? "Error de entrega en WhatsApp / Meta",
              customBody: renderedBody || r.customBody,
            });
            await this.campaignRepo.incrementCounters(id, { sent: -1, failed: 1 });
            stateChanged = true;
          }
        }
      }
      if (stateChanged) {
        recipients = await this.recipientRepo.listByCampaignId(id);
      }
    }

    const updatedCampaign = await this.campaignRepo.findById(id);
    const finalCampaign = updatedCampaign || campaign;

    const progress =
      finalCampaign.totalRecipients > 0
        ? Math.round((finalCampaign.sentCount / finalCampaign.totalRecipients) * 100)
        : 0;

    const enrichedRecipients = recipients.map((r) => {
      const body = r.customBody || interpolateRecipientBody(campaign, r, templateBodyText);
      return {
        ...r,
        customBody: body,
      };
    });

    return {
      ...finalCampaign,
      progress,
      recipients: enrichedRecipients,
    };
  }
}

