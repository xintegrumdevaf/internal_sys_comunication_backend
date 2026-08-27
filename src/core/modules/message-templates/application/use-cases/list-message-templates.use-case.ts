import type {
  ListMessageTemplatesFilter,
  ListMessageTemplatesResult,
  MessageTemplateRepositoryPort,
} from "../ports/message-template.repository.port";

export class ListMessageTemplatesUseCase {
  constructor(private readonly templateRepo: MessageTemplateRepositoryPort) {}

  async execute(filter: ListMessageTemplatesFilter): Promise<ListMessageTemplatesResult> {
    return this.templateRepo.list(filter);
  }
}
