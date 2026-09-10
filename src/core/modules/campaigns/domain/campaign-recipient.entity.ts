export type RecipientStatus = "PENDING" | "SENT" | "FAILED" | "SKIPPED";

export interface CampaignRecipient {
  id: string;
  campaignId: string;
  phone: string;
  name: string | null;
  customBody: string | null;
  status: RecipientStatus;
  externalId: string | null;
  errorMessage: string | null;
  sentAt: Date | null;
}
