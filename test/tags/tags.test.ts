import { describe, expect, it } from "vitest";
import type { Tag } from "../../src/core/modules/tags/domain/tag.entity";
import type { CreateTagInput, TagRepositoryPort, UpdateTagInput } from "../../src/core/modules/tags/application/ports/tag.repository.port";
import { ListTagsUseCase } from "../../src/core/modules/tags/application/use-cases/list-tags.use-case";
import { CreateTagUseCase } from "../../src/core/modules/tags/application/use-cases/create-tag.use-case";
import { UpdateTagUseCase } from "../../src/core/modules/tags/application/use-cases/update-tag.use-case";
import { DeleteTagUseCase } from "../../src/core/modules/tags/application/use-cases/delete-tag.use-case";

class TagRepositoryFake implements TagRepositoryPort {
  private tags: Tag[] = [
    {
      id: "tag-1",
      name: "AGENDADO",
      description: "Seguimiento estándar agendado",
      color: "ambar",
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: "tag-2",
      name: "MONITOREO",
      description: "En observación técnica de servicio",
      color: "azul",
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  async findAll(includeInactive = false): Promise<Tag[]> {
    return includeInactive ? [...this.tags] : this.tags.filter((t) => t.active);
  }

  async findById(id: string): Promise<Tag | null> {
    return this.tags.find((t) => t.id === id) ?? null;
  }

  async findByName(name: string): Promise<Tag | null> {
    return this.tags.find((t) => t.name.toUpperCase() === name.toUpperCase()) ?? null;
  }

  async create(input: CreateTagInput): Promise<Tag> {
    const tag: Tag = {
      id: `tag-${Date.now()}`,
      name: input.name.trim().toUpperCase(),
      description: input.description ?? null,
      color: input.color ?? null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tags.push(tag);
    return tag;
  }

  async update(id: string, input: UpdateTagInput): Promise<Tag | null> {
    const tag = await this.findById(id);
    if (!tag) return null;
    if (input.name !== undefined) tag.name = input.name.trim().toUpperCase();
    if (input.description !== undefined) tag.description = input.description;
    if (input.color !== undefined) tag.color = input.color;
    if (input.active !== undefined) tag.active = input.active;
    tag.updatedAt = new Date();
    return tag;
  }

  async delete(id: string): Promise<boolean> {
    const index = this.tags.findIndex((t) => t.id === id);
    if (index === -1) return false;
    this.tags.splice(index, 1);
    return true;
  }
}

describe("Catálogo de etiquetas (Tags CRUD)", () => {
  it("lista las etiquetas activas", async () => {
    const repo = new TagRepositoryFake();
    const listTags = new ListTagsUseCase(repo);
    const result = await listTags.execute();
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toContain("AGENDADO");
    expect(result.map((t) => t.name)).toContain("MONITOREO");
  });

  it("crea una nueva etiqueta exitosamente", async () => {
    const repo = new TagRepositoryFake();
    const createTag = new CreateTagUseCase(repo);
    const created = await createTag.execute({
      name: "REVISION_TECNICA",
      description: "Revisión en campo",
      color: "esmeralda",
    });
    expect(created.name).toBe("REVISION_TECNICA");
    expect(created.color).toBe("esmeralda");
  });

  it("rechaza duplicados al crear una etiqueta con el mismo nombre", async () => {
    const repo = new TagRepositoryFake();
    const createTag = new CreateTagUseCase(repo);
    await expect(
      createTag.execute({ name: "agendado", description: "Duplicado" }),
    ).rejects.toThrow("ya existe");
  });

  it("actualiza el color o descripción de una etiqueta existente", async () => {
    const repo = new TagRepositoryFake();
    const updateTag = new UpdateTagUseCase(repo);
    const updated = await updateTag.execute("tag-1", {
      color: "morado",
      description: "Descripción actualizada",
    });
    expect(updated.color).toBe("morado");
    expect(updated.description).toBe("Descripción actualizada");
  });

  it("elimina una etiqueta del catálogo", async () => {
    const repo = new TagRepositoryFake();
    const deleteTag = new DeleteTagUseCase(repo);
    const listTags = new ListTagsUseCase(repo);

    await deleteTag.execute("tag-2");
    const remaining = await listTags.execute();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("tag-1");
  });
});
