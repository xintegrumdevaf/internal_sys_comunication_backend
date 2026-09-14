import type { QuickReply, QuickReplyFilter } from "../../domain/quick-reply.entity";

export interface QuickReplyRepositoryPort {
  findById(id: string): Promise<QuickReply | null>;
  findByShortcut(shortcut: string, departmentId: string | null): Promise<QuickReply | null>;
  list(filter?: QuickReplyFilter): Promise<QuickReply[]>;
  save(reply: QuickReply): Promise<void>;
  delete(id: string): Promise<void>;
}
