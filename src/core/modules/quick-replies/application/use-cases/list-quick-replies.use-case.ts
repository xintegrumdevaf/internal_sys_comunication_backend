import type { QuickReplyRepositoryPort } from "../ports/quick-reply.repository.port";
import type { QuickReply } from "../../domain/quick-reply.entity";
import type { Agent } from "../../../departments/domain/agent.entity";

export interface ListQuickRepliesQuery {
  departmentId?: string | null;
  search?: string;
  category?: string;
  activeOnly?: boolean;
}

export class ListQuickRepliesUseCase {
  constructor(private readonly quickReplyRepo: QuickReplyRepositoryPort) {}

  async execute(query: ListQuickRepliesQuery, actor: Agent): Promise<QuickReply[]> {
    const actorDeptIds = [
      ...(actor.primaryDepartmentId ? [actor.primaryDepartmentId] : []),
      ...(actor.departmentIds ?? []),
    ];

    let targetDeptIds: (string | null)[] | undefined = undefined;

    if (actor.role === "admin") {
      if (query.departmentId !== undefined) {
        targetDeptIds = [query.departmentId];
      }
    } else {
      // Manager o Agent: solo pueden consultar ámbito general + sus departamentos asignados
      if (query.departmentId !== undefined) {
        if (query.departmentId === null) {
          targetDeptIds = [null];
        } else if (actorDeptIds.includes(query.departmentId)) {
          targetDeptIds = [query.departmentId];
        } else {
          // Si solicita un departamento no asignado, solo ve los globales
          targetDeptIds = [null];
        }
      } else {
        targetDeptIds = [null, ...actorDeptIds];
      }
    }

    const activeOnly = actor.role === "agent" ? true : (query.activeOnly ?? true);

    return this.quickReplyRepo.list({
      departmentIds: targetDeptIds,
      search: query.search,
      category: query.category,
      activeOnly,
    });
  }
}
