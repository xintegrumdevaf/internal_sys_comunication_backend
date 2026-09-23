import type { PromptTemplateRepositoryPort, PromptTemplateWithActiveVersion } from "../ports/prompt-template.repository.port";

export class ListPromptsUseCase {
  constructor(private readonly promptRepo: PromptTemplateRepositoryPort) {}

  async execute(): Promise<PromptTemplateWithActiveVersion[]> {
    return this.promptRepo.listTemplates();
  }
}
