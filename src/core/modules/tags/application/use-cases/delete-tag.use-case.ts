import { notFound } from "../../../../../shared/errors/domain-errors";
import type { TagRepositoryPort } from "../ports/tag.repository.port";

export class DeleteTagUseCase {
  constructor(private readonly tagRepo: TagRepositoryPort) {}

  async execute(id: string): Promise<void> {
    const existing = await this.tagRepo.findById(id);
    if (!existing) {
      throw notFound(`Etiqueta ${id} no encontrada`);
    }
    await this.tagRepo.delete(id);
  }
}
