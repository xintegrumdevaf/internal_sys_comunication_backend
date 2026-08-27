import { authorizationError } from "../../../../shared/errors/domain-errors";
import type { Agent } from "../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../departments/application/ports/agent.repository.port";

/**
 * Resuelve el alcance de departamentos para auditoría:
 * - admin: ve todo (o filtra por requestedDepartmentId si se envía).
 * - manager: ve únicamente eventos de sus departamentos (memberships + primaryDepartmentId).
 * - agent: 403 Forbidden.
 */
export async function resolveAuditDepartmentScope(
  actor: Agent,
  agentRepo: AgentRepositoryPort,
  requestedDepartmentId?: string
): Promise<string[] | null> {
  if (actor.role === "admin") {
    return requestedDepartmentId ? [requestedDepartmentId] : null;
  }

  if (actor.role !== "manager") {
    throw authorizationError("Se requiere rol manager o admin para acceder a la auditoria");
  }

  const memberships = await agentRepo.listMembershipDepartmentIds(actor.id);
  const scoped = new Set<string>(memberships);
  if (actor.primaryDepartmentId) scoped.add(actor.primaryDepartmentId);

  if (requestedDepartmentId) {
    if (!scoped.has(requestedDepartmentId)) {
      throw authorizationError("No tienes alcance de auditoria sobre este departamento");
    }
    return [requestedDepartmentId];
  }

  return [...scoped];
}
