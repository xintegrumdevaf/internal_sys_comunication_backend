import type {
  MessageTemplateCategory,
  MessageTemplateHeaderType,
  MessageTemplateStatus,
  TemplateButton,
} from "../../domain/message-template.entity";

export interface SubmitTemplateInput {
  name: string;
  category: MessageTemplateCategory;
  language: string;
  headerType: MessageTemplateHeaderType;
  headerContent?: string | null;
  bodyText: string;
  footerText?: string | null;
  buttons?: TemplateButton[] | null;
}

export interface SubmitTemplateResult {
  metaTemplateId: string;
  status: MessageTemplateStatus;
}

export interface FetchTemplateStatusResult {
  metaTemplateId: string;
  status: MessageTemplateStatus;
  rejectedReason?: string | null;
}

export interface MetaTemplatesGatewayPort {
  submitTemplate(template: SubmitTemplateInput): Promise<SubmitTemplateResult>;
  fetchTemplateStatus(metaTemplateId: string): Promise<FetchTemplateStatusResult>;
  deleteTemplate(metaTemplateId: string, name: string): Promise<boolean>;
}
