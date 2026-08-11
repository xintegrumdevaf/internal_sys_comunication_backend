import { businessError } from "../../../../../shared/errors/domain-errors";
import type { Agent, AgentRole } from "../../domain/agent.entity";
import type { AgentRepositoryPort } from "../ports/agent.repository.port";

/**
 * docs/spec/06_BACKEND_GAPS.md §1: "No permitir desactivar al único
 * role=admin activo". Se aplica tanto a `active: false` como a un cambio de
 * rol que le quite `admin` a quien hoy es el único admin activo — ambos
 * caminos dejarían al sistema sin nadie que pueda administrar agentes.
 */
export async function assertKeepsAtLeastOneActiveAdmin(
  agentRepo: AgentRepositoryPort,
  current: Agent,
  next: { active?: boolean; role?: AgentRole },
): Promise<void> {
  if (current.role !== "admin" || !current.active) return;

  const willBeInactive = next.active === false;
  const willLoseAdminRole = next.role !== undefined && next.role !== "admin";
  if (!willBeInactive && !willLoseAdminRole) return;

  const remaining = await agentRepo.countActiveAdmins(current.id);
  if (remaining === 0) {
    throw businessError(
      "No se puede desactivar ni quitarle el rol admin al único administrador activo del sistema",
    );
  }
}
