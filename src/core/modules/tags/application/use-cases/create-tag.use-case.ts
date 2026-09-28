import { businessError } from "../../../../../shared/errors/domain-errors";
import type { Tag } from "../../domain/tag.entity";
import type { CreateTagInput, TagRepositoryPort } from "../ports/tag.repository.port";

export class CreateTagUseCase {
  constructor(private readonly tagRepo: TagRepositoryPort) {}

  async execute(input: CreateTagInput): Promise<Tag> {
    const cleanName = input.name.trim().toUpperCase();
    if (!cleanName) {
      throw businessError("El nombre de la etiqueta no puede estar vacío");
    }

    const existing = await this.tagRepo.findByName(cleanName);
    if (existing) {
      throw businessError(`La etiqueta '${cleanName}' ya existe`);
    }

    return this.tagRepo.create({
      name: cleanName,
      description: input.description ?? null,
      color: input.color ?? null,
    });
  }
}
