import { authorizationError } from "../../../../shared/errors/domain-errors";
import type { Agent } from "../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../departments/application/ports/agent.repository.port";

/**
 * Resuelve el alcance de departamentos para el módulo de analíticas:
 * - admin: acceso global (null) o a un departamento específico si lo pasa como filtro.
 * - manager: restringido a su primaryDepartmentId y departamentos de agent_membership.
 * - agent: 403 Forbidden.
 */
export async function resolveAnalyticsDepartmentScope(
  actor: Agent,
  agentRepo: AgentRepositoryPort,
  requestedDepartmentId?: string,
): Promise<string[] | null> {
  if (actor.role === "admin") {
    return requestedDepartmentId ? [requestedDepartmentId] : null;
  }

  if (actor.role !== "manager") {
    throw authorizationError("Se requiere rol manager o admin para acceder a analíticas");
  }

  const memberships = await agentRepo.listMembershipDepartmentIds(actor.id);
  const scoped = new Set<string>(memberships);
  if (actor.primaryDepartmentId) {
    scoped.add(actor.primaryDepartmentId);
  }

  if (requestedDepartmentId) {
    if (!scoped.has(requestedDepartmentId)) {
      throw authorizationError("No tienes alcance sobre este departamento");
    }
    return [requestedDepartmentId];
  }

  return [...scoped];
}
