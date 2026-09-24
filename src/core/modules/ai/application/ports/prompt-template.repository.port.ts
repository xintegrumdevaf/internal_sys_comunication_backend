import type { PromptTemplate } from "../../domain/entities/prompt-template.entity";
import type { PromptModelConfig, PromptVersion } from "../../domain/entities/prompt-version.entity";

export interface CreatePromptVersionInput {
  templateId: string;
  systemPrompt: string;
  userTemplate: string;
  modelConfig?: PromptModelConfig;
  changeNotes?: string;
  createdBy?: string;
  status?: "DRAFT" | "PUBLISHED";
}

export interface PromptTemplateWithActiveVersion extends PromptTemplate {
  activeVersion?: PromptVersion | null;
  versionsCount?: number;
}

export interface PromptTemplateRepositoryPort {
  listTemplates(): Promise<PromptTemplateWithActiveVersion[]>;
  findBySlug(slug: string): Promise<PromptTemplate | null>;
  findById(id: string): Promise<PromptTemplate | null>;
  getActiveVersion(templateId: string): Promise<PromptVersion | null>;
  getActiveVersionBySlug(slug: string): Promise<PromptVersion | null>;
  listVersions(templateId: string): Promise<PromptVersion[]>;
  findVersionById(versionId: string): Promise<PromptVersion | null>;
  createVersion(input: CreatePromptVersionInput): Promise<PromptVersion>;
  setActiveVersion(templateId: string, versionId: string): Promise<void>;
}
