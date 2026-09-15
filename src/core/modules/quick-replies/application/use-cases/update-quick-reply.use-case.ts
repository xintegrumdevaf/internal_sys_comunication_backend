import type { QuickReplyRepositoryPort } from "../ports/quick-reply.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { QuickReplyCatalogService } from "../services/quick-reply-catalog.service";
import type { QuickReply, UpdateQuickReplyDto } from "../../domain/quick-reply.entity";
import type { Agent } from "../../../departments/domain/agent.entity";
import {
  authorizationError,
  businessError,
  notFound,
  validationError,
} from "../../../../../shared/errors/domain-errors";

export interface UpdateQuickReplyDeps {
  quickReplyRepo: QuickReplyRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  catalogService: QuickReplyCatalogService;
}

export class UpdateQuickReplyUseCase {
  constructor(private readonly deps: UpdateQuickReplyDeps) {}

  async execute(id: string, dto: UpdateQuickReplyDto, actor: Agent): Promise<QuickReply> {
    const existing = await this.deps.quickReplyRepo.findById(id);
    if (!existing) {
      throw notFound("La respuesta rápida no existe");
    }

    // Comprobar permisos sobre el recurso actual
    if (existing.departmentId === null) {
      if (actor.role !== "admin") {
        throw authorizationError(
          "Solo los administradores pueden modificar respuestas rápidas de alcance general",
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
            "No tienes permisos para modificar respuestas rápidas de este departamento",
          );
        }
      }
    }

    let targetDepartmentId = existing.departmentId;
    if (dto.departmentId !== undefined) {
      targetDepartmentId = dto.departmentId;
      if (targetDepartmentId === null) {
        if (actor.role !== "admin") {
          throw authorizationError(
            "Solo los administradores pueden cambiar el alcance a general",
          );
        }
      } else {
        if (actor.role !== "admin") {
          const allowedDeptIds = [
            ...(actor.primaryDepartmentId ? [actor.primaryDepartmentId] : []),
            ...(actor.departmentIds ?? []),
          ];
          if (!allowedDeptIds.includes(targetDepartmentId)) {
            throw authorizationError(
              "No puedes transferir la respuesta rápida a un departamento al que no perteneces",
            );
          }
        }
        const dept = await this.deps.departmentRepo.findById(targetDepartmentId);
        if (!dept || !dept.active) {
          throw notFound("El departamento destino no existe o está inactivo");
        }
      }
    }

    let targetShortcut = existing.shortcut;
    if (dto.shortcut !== undefined) {
      const rawShortcut = dto.shortcut.trim();
      if (!rawShortcut) {
        throw validationError("El atajo (shortcut) no puede quedar vacío");
      }
      targetShortcut = this.deps.catalogService.normalizeShortcut(rawShortcut);
      if (!/^[a-z0-9_-]+$/.test(targetShortcut)) {
        throw validationError(
          "El atajo solo puede contener letras, números, guiones y guiones bajos",
        );
      }
    }

    // Si cambió el atajo o el departamento, verificar que no colisione con otro
    if (targetShortcut !== existing.shortcut || targetDepartmentId !== existing.departmentId) {
      const duplicate = await this.deps.quickReplyRepo.findByShortcut(
        targetShortcut,
        targetDepartmentId,
      );
      if (duplicate && duplicate.id !== existing.id) {
        throw businessError(
          `Ya existe otra respuesta rápida con el atajo "/${targetShortcut}" en el ámbito de destino`,
        );
      }
    }

    const updated: QuickReply = {
      ...existing,
      shortcut: targetShortcut,
      title: dto.title !== undefined ? dto.title.trim() : existing.title,
      body: dto.body !== undefined ? dto.body.trim() : existing.body,
      departmentId: targetDepartmentId,
      category: dto.category !== undefined ? (dto.category?.trim() || null) : existing.category,
      mediaUrl: dto.mediaUrl !== undefined ? (dto.mediaUrl?.trim() || null) : existing.mediaUrl,
      active: dto.active !== undefined ? dto.active : existing.active,
      updatedAt: new Date(),
    };

    if (!updated.title || updated.title.length < 2) {
      throw validationError("El título debe tener al menos 2 caracteres");
    }
    if (!updated.body || updated.body.length < 1) {
      throw validationError("El cuerpo de la respuesta rápida no puede estar vacío");
    }

    await this.deps.quickReplyRepo.save(updated);
    await this.deps.catalogService.invalidateCache();

    return updated;
  }
}
