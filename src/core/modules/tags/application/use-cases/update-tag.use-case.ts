import { businessError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Tag } from "../../domain/tag.entity";
import type { TagRepositoryPort, UpdateTagInput } from "../ports/tag.repository.port";

export class UpdateTagUseCase {
  constructor(private readonly tagRepo: TagRepositoryPort) {}

  async execute(id: string, input: UpdateTagInput): Promise<Tag> {
    const existing = await this.tagRepo.findById(id);
    if (!existing) {
      throw notFound(`Etiqueta ${id} no encontrada`);
    }

    if (input.name !== undefined) {
      const cleanName = input.name.trim().toUpperCase();
      if (!cleanName) {
        throw businessError("El nombre de la etiqueta no puede estar vacío");
      }
      const duplicate = await this.tagRepo.findByName(cleanName);
      if (duplicate && duplicate.id !== id) {
        throw businessError(`La etiqueta '${cleanName}' ya existe`);
      }
    }

    const updated = await this.tagRepo.update(id, input);
    if (!updated) {
      throw notFound(`Etiqueta ${id} no encontrada`);
    }
    return updated;
  }
}
