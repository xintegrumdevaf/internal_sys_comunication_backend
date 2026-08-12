import { authorizationError } from "../../../../shared/errors/domain-errors";
import type { Agent } from "../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../departments/application/ports/agent.repository.port";

/**
 * Alcance de calidad (07_QUALITY_SUPERVISION.md §3):
 * - admin: todo
 * - manager: department_id ∈ memberships O primaryDepartmentId
 * - department_id null (triage): solo admin
 */
export async function assertCanAccessQualityDepartment(
  actor: Agent,
  departmentId: string | null,
  agentRepo: AgentRepositoryPort,
): Promise<void> {
  if (actor.role === "admin") return;

  if (actor.role !== "manager") {
    throw authorizationError("Se requiere rol manager o admin para calidad");
  }

  if (departmentId === null) {
    throw authorizationError("Solo un admin puede acceder a reviews sin departamento");
  }

  if (actor.primaryDepartmentId === departmentId) return;

  const belongs = await agentRepo.belongsToDepartment(actor.id, departmentId);
  if (!belongs) {
    throw authorizationError("No tienes alcance sobre este departamento");
  }
}

/** Resuelve los departmentIds visibles para listados/stats. null = sin restriccion (admin). */
export async function resolveQualityDepartmentScope(
  actor: Agent,
  agentRepo: AgentRepositoryPort,
  requestedDepartmentId?: string,
): Promise<string[] | null> {
  if (actor.role === "admin") {
    return requestedDepartmentId ? [requestedDepartmentId] : null;
  }

  if (actor.role !== "manager") {
    throw authorizationError("Se requiere rol manager o admin para calidad");
  }

  const memberships = await agentRepo.listMembershipDepartmentIds(actor.id);
  const scoped = new Set<string>(memberships);
  if (actor.primaryDepartmentId) scoped.add(actor.primaryDepartmentId);

  if (requestedDepartmentId) {
    if (!scoped.has(requestedDepartmentId)) {
      throw authorizationError("No tienes alcance sobre este departamento");
    }
    return [requestedDepartmentId];
  }

  return [...scoped];
}
