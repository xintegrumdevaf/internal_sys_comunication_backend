import type { Campaign } from "../../domain/campaign.entity";
import type { CampaignRecipient } from "../../domain/campaign-recipient.entity";
import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";
import type { CampaignRecipientRepositoryPort } from "../ports/campaign-recipient.repository.port";
import type { WhatsAppSenderPort } from "../../../conversations/application/ports/whatsapp-sender.port";
import type { MessageTemplateRepositoryPort } from "../../../message-templates/application/ports/message-template.repository.port";
import { translateDeliveryError } from "../../../conversations/domain/meta-delivery-error";

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

    const recipients = await this.recipientRepo.listByCampaignId(id);

    let templateBodyText: string | undefined;
    if (campaign.templateName && this.messageTemplateRepo) {
      const tpl = await this.messageTemplateRepo.findByName(campaign.templateName);
      if (tpl) {
        templateBodyText = tpl.bodyText || undefined;
      }
    }

    const processedCount = campaign.sentCount + campaign.failedCount;
    const progress =
      campaign.totalRecipients > 0
        ? Math.min(100, Math.round((processedCount / campaign.totalRecipients) * 100))
        : 0;

    const enrichedRecipients = recipients.map((r) => {
      const body = r.customBody || interpolateRecipientBody(campaign, r, templateBodyText);
      const translatedErrorMessage = r.errorMessage ? translateDeliveryError(r.errorMessage) : null;
      return {
        ...r,
        customBody: body,
        errorMessage: translatedErrorMessage,
      };
    });

    return {
      ...campaign,
      progress,
      recipients: enrichedRecipients,
    };
  }
}

