import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";

export type AutoAssignAgentDeps = {
  agentRepo: AgentRepositoryPort;
  caseRepo: CaseRepositoryPort;
  /**
   * Umbral de carga (docs/spec/06_BACKEND_GAPS.md §2): un agente con esta
   * cantidad de casos `HUMAN_ACTIVE` o mas queda fuera de la seleccion
   * automatica (sigue disponible para asignacion manual por un manager).
   */
  maxActiveCasesPerAgent: number;
};

/**
 * Elige el agente humano que debe recibir un caso recien escalado dentro de
 * un departamento (docs/spec/06_BACKEND_GAPS.md §2). Reglas:
 *
 * 1. Solo agentes `active` con `role` `agent` o `manager` (los `admin` no
 *    reciben carga operativa automatica).
 * 2. Elegibles: `primaryDepartmentId` del departamento, o con
 *    `agent_membership` explicita en el (departamentos `restricted` con
 *    varios agentes asignados via membership).
 * 3. Se excluyen los que ya estan en o por encima del umbral de carga.
 * 4. Entre los elegibles, se elige el de MENOR carga activa; el empate se
 *    resuelve por nombre (orden simple y determinista — no hay todavia un
 *    registro de "ultima asignacion" para un round-robin mas fino).
 * 5. Si no queda nadie elegible, devuelve `null` — el caso se queda sin
 *    asignar en el pool de escalaciones para que un manager/admin lo asigne
 *    a mano (nunca se fuerza una asignacion a alguien sobrecargado).
 */
export class AutoAssignAgentService {
  constructor(private readonly deps: AutoAssignAgentDeps) {}

  async pickAgentForDepartment(departmentId: string): Promise<Agent | null> {
    const allAgents = await this.deps.agentRepo.list();
    const roleEligible = allAgents.filter((a) => a.active && (a.role === "agent" || a.role === "manager"));

    const eligible: Agent[] = [];
    for (const agent of roleEligible) {
      if (agent.primaryDepartmentId === departmentId) {
        eligible.push(agent);
        continue;
      }
      const belongs = await this.deps.agentRepo.belongsToDepartment(agent.id, departmentId);
      if (belongs) eligible.push(agent);
    }
    if (eligible.length === 0) return null;

    const loads = await this.deps.caseRepo.countActiveCasesByAgent(eligible.map((a) => a.id));
    const underThreshold = eligible.filter((a) => (loads[a.id] ?? 0) < this.deps.maxActiveCasesPerAgent);
    if (underThreshold.length === 0) return null;

    underThreshold.sort((a, b) => {
      const diff = (loads[a.id] ?? 0) - (loads[b.id] ?? 0);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, "es");
    });

    return underThreshold[0]!;
  }
}
