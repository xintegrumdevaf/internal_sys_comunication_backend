import type { CampaignRepositoryPort } from "../ports/campaign.repository.port";
import type { CampaignRecipientRepositoryPort } from "../ports/campaign-recipient.repository.port";
import type {
  CampaignFileParserService,
  FileImportError,
} from "../services/campaign-file-parser.service";

export type ImportRecipientsOutput = {
  summary: {
    totalProcessed: number;
    validCount: number;
    invalidCount: number;
  };
  errors: FileImportError[];
};

export class ImportCampaignRecipientsUseCase {
  constructor(
    private readonly campaignRepo: CampaignRepositoryPort,
    private readonly recipientRepo: CampaignRecipientRepositoryPort,
    private readonly fileParser: CampaignFileParserService,
  ) {}

  async execute(campaignId: string, buffer: Buffer): Promise<ImportRecipientsOutput> {
    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) {
      throw new Error(`Campaña ${campaignId} no encontrada`);
    }

    if (campaign.status !== "DRAFT") {
      throw new Error("Solo se pueden importar destinatarios en campañas en estado DRAFT");
    }

    const parseResult = this.fileParser.parseBuffer(buffer);

    let validInserted = 0;
    if (parseResult.validRecipients.length > 0) {
      validInserted = await this.recipientRepo.bulkInsert(
        campaignId,
        parseResult.validRecipients,
      );

      const counts = await this.recipientRepo.countByCampaign(campaignId);
      await this.campaignRepo.updateTotalRecipients(campaignId, counts.total);
    }

    return {
      summary: {
        totalProcessed: parseResult.totalProcessed,
        validCount: validInserted,
        invalidCount: parseResult.errors.length,
      },
      errors: parseResult.errors,
    };
  }
}
