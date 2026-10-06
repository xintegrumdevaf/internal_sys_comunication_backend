import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";

export type AutoAssignAgentDeps = {
  agentRepo: AgentRepositoryPort;
  caseRepo: CaseRepositoryPort;
  /**
   * Umbral opcional de referencia o telemetría.
   */
  maxActiveCasesPerAgent?: number;
};

/**
 * Elige el agente humano que debe recibir un caso recién escalado dentro de
 * un departamento. Reglas:
 *
 * 1. Solo agentes `active` con `autoAssignEnabled` y `role` `agent` o
 *    `manager` (los `admin` no reciben carga operativa automática).
 * 2. Elegibles: `primaryDepartmentId` del departamento, o con
 *    `agent_membership` explícita en él (departamentos `restricted` con
 *    varios agentes asignados vía membership).
 * 3. Balanceo Equitativo Garantizado (Least-Connections): Entre los elegibles,
 *    se elige al de MENOR carga activa en ese instante (`HUMAN_ACTIVE`).
 * 4. Desempate determinista por nombre.
 * 5. Si no hay ningún agente elegible en turno, devuelve `null` — el caso
 *    queda en estado ESCALATED en el pool del departamento a la espera de claim
 *    o asignación manual.
 */
export class AutoAssignAgentService {
  constructor(private readonly deps: AutoAssignAgentDeps) {}

  async pickAgentForDepartment(departmentId: string): Promise<Agent | null> {
    const allAgents = await this.deps.agentRepo.list();
    const roleEligible = allAgents.filter(
      (a) => a.active && a.autoAssignEnabled && (a.role === "agent" || a.role === "manager"),
    );

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

    // Balanceo Equitativo Garantizado (Least-Connections):
    // Siempre se elige al agente con menor carga activa en ese instante.
    // Si todos los agentes están por encima de un umbral orientativo, el sistema
    // NO bloquea la atención ni deja al cliente huérfano: continúa repartiendo
    // de forma simétrica y justa entre los agentes en turno.
    eligible.sort((a, b) => {
      const diff = (loads[a.id] ?? 0) - (loads[b.id] ?? 0);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, "es");
    });

    return eligible[0]!;
  }
}
