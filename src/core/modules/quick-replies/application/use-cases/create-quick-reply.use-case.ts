import { randomUUID } from "crypto";
import type { QuickReplyRepositoryPort } from "../ports/quick-reply.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { QuickReplyCatalogService } from "../services/quick-reply-catalog.service";
import type { QuickReply, CreateQuickReplyDto } from "../../domain/quick-reply.entity";
import type { Agent } from "../../../departments/domain/agent.entity";
import {
  authorizationError,
  businessError,
  validationError,
  notFound,
} from "../../../../../shared/errors/domain-errors";

export interface CreateQuickReplyDeps {
  quickReplyRepo: QuickReplyRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  catalogService: QuickReplyCatalogService;
}

export class CreateQuickReplyUseCase {
  constructor(private readonly deps: CreateQuickReplyDeps) {}

  async execute(dto: CreateQuickReplyDto, actor: Agent): Promise<QuickReply> {
    const rawShortcut = dto.shortcut?.trim();
    if (!rawShortcut) {
      throw validationError("El atajo (shortcut) es requerido");
    }

    const shortcut = this.deps.catalogService.normalizeShortcut(rawShortcut);
    if (!/^[a-z0-9_-]+$/.test(shortcut)) {
      throw validationError(
        "El atajo solo puede contener letras, números, guiones y guiones bajos (sin espacios ni caracteres especiales)",
      );
    }

    const title = dto.title?.trim();
    if (!title || title.length < 2) {
      throw validationError("El título debe tener al menos 2 caracteres");
    }

    const body = dto.body?.trim();
    if (!body || body.length < 1) {
      throw validationError("El contenido de la respuesta rápida no puede estar vacío");
    }

    const departmentId = dto.departmentId ?? null;

    // Validación de permisos por rol
    if (departmentId === null) {
      if (actor.role !== "admin") {
        throw authorizationError(
          "Solo los administradores pueden crear respuestas rápidas de alcance general",
        );
      }
    } else {
      if (actor.role !== "admin") {
        const allowedDeptIds = [
          ...(actor.primaryDepartmentId ? [actor.primaryDepartmentId] : []),
          ...(actor.departmentIds ?? []),
        ];
        if (!allowedDeptIds.includes(departmentId)) {
          throw authorizationError(
            "No tienes permisos para crear respuestas rápidas en un departamento al que no perteneces",
          );
        }
      }

      // Validar que el departamento exista y esté activo
      const department = await this.deps.departmentRepo.findById(departmentId);
      if (!department || !department.active) {
        throw notFound("El departamento especificado no existe o está inactivo");
      }
    }

    // Verificar unicidad de atajo dentro del ámbito
    const existing = await this.deps.quickReplyRepo.findByShortcut(shortcut, departmentId);
    if (existing) {
      throw businessError(
        `Ya existe una respuesta rápida con el atajo "/${shortcut}" en este ámbito`,
      );
    }

    const now = new Date();
    const quickReply: QuickReply = {
      id: randomUUID(),
      shortcut,
      title,
      body,
      departmentId,
      category: dto.category?.trim() || null,
      mediaUrl: dto.mediaUrl?.trim() || null,
      createdByAgentId: actor.id,
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.deps.quickReplyRepo.save(quickReply);
    await this.deps.catalogService.invalidateCache();

    return quickReply;
  }
}
