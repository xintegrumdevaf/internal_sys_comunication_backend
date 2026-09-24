export type PromptVersionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface PromptModelConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  [key: string]: unknown;
}

export interface PromptVersion {
  id: string;
  templateId: string;
  versionNumber: number;
  systemPrompt: string;
  userTemplate: string;
  modelConfig: PromptModelConfig;
  status: PromptVersionStatus;
  changeNotes?: string | null;
  createdBy?: string | null;
  publishedAt?: Date | null;
  createdAt: Date;
}
