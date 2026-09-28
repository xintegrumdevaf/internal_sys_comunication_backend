import type { Tag } from "../../domain/tag.entity";
import type { TagRepositoryPort } from "../ports/tag.repository.port";

export class ListTagsUseCase {
  constructor(private readonly tagRepo: TagRepositoryPort) {}

  async execute(includeInactive = false): Promise<Tag[]> {
    return this.tagRepo.findAll(includeInactive);
  }
}
