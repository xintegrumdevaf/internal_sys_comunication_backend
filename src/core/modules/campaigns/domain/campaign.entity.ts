export type CampaignStatus = "DRAFT" | "RUNNING" | "SUSPENDED" | "COMPLETED" | "FAILED";

export type CampaignChatRouting = {
  initialStatus: "OPEN" | "PENDING" | "CLOSED";
  departmentId: string | null;
  assignedAgentId: string | null;
  keepAssignedToUser: boolean;
  delegateToBot: boolean;
  forceChatUpdate: boolean;
};

export type CampaignContactEnrichment = {
  tagIds: string[];
  additionalFields: Record<string, string>;
  forceUpdateContactData: boolean;
};

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  messageBody: string;
  quickMode: boolean;
  quickModeIntervalSeconds: number;
  chatRouting: CampaignChatRouting;
  contactEnrichment: CampaignContactEnrichment;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  templateName?: string | null;
  templateLanguage?: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
