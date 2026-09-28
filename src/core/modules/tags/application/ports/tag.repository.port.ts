import type { Tag } from "../../domain/tag.entity";

export type CreateTagInput = {
  name: string;
  description?: string | null;
  color?: string | null;
};

export type UpdateTagInput = {
  name?: string;
  description?: string | null;
  color?: string | null;
  active?: boolean;
};

export interface TagRepositoryPort {
  findAll(includeInactive?: boolean): Promise<Tag[]>;
  findById(id: string): Promise<Tag | null>;
  findByName(name: string): Promise<Tag | null>;
  create(input: CreateTagInput): Promise<Tag>;
  update(id: string, input: UpdateTagInput): Promise<Tag | null>;
  delete(id: string): Promise<boolean>;
}
