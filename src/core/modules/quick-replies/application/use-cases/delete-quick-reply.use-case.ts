import type { QuickReplyRepositoryPort } from "../ports/quick-reply.repository.port";
import type { QuickReplyCatalogService } from "../services/quick-reply-catalog.service";
import type { Agent } from "../../../departments/domain/agent.entity";
import { authorizationError, notFound } from "../../../../../shared/errors/domain-errors";

export interface DeleteQuickReplyDeps {
  quickReplyRepo: QuickReplyRepositoryPort;
  catalogService: QuickReplyCatalogService;
}

export class DeleteQuickReplyUseCase {
  constructor(private readonly deps: DeleteQuickReplyDeps) {}

  async execute(id: string, actor: Agent): Promise<void> {
    const existing = await this.deps.quickReplyRepo.findById(id);
    if (!existing) {
      throw notFound("La respuesta rápida no existe");
    }

    if (existing.departmentId === null) {
      if (actor.role !== "admin") {
        throw authorizationError(
          "Solo los administradores pueden eliminar respuestas rápidas de alcance general",
        );
      }
    } else {
      if (actor.role !== "admin") {
        const allowedDeptIds = [
          ...(actor.primaryDepartmentId ? [actor.primaryDepartmentId] : []),
          ...(actor.departmentIds ?? []),
        ];
        if (!allowedDeptIds.includes(existing.departmentId)) {
          throw authorizationError(
            "No tienes permisos para eliminar respuestas rápidas de este departamento",
          );
        }
      }
    }

    await this.deps.quickReplyRepo.delete(id);
    await this.deps.catalogService.invalidateCache();
  }
}
