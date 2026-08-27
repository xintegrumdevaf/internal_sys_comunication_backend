export type MessageTemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";

export type MessageTemplateHeaderType = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";

export type MessageTemplateStatus = "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED";

export type TemplateButtonType = "QUICK_REPLY" | "URL" | "PHONE_NUMBER";

export interface TemplateButton {
  type: TemplateButtonType;
  text: string;
  url?: string;
  phoneNumber?: string;
}

export interface MessageTemplate {
  id: string;
  name: string;
  category: MessageTemplateCategory;
  language: string;
  headerType: MessageTemplateHeaderType;
  headerContent: string | null;
  bodyText: string;
  footerText: string | null;
  buttons: TemplateButton[] | null;
  status: MessageTemplateStatus;
  metaTemplateId: string | null;
  rejectedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
