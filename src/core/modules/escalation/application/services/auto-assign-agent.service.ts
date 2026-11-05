import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export type AutoAssignAgentDeps = {
  agentRepo: AgentRepositoryPort;
  caseRepo: CaseRepositoryPort;
  departmentRepo?: Pick<DepartmentRepositoryPort, "findById">;
  broadcaster?: Pick<RealtimeBroadcaster, "isUserConnected">;
  /**
   * Umbral opcional de referencia o fallback por defecto (default: 6).
   */
  maxActiveCasesPerAgent?: number;
};

export type AutoAssignOptions = {
  /**
   * Si es true, si no hay agentes con autoAssignEnabled=true, busca entre los agentes
   * activos del departamento (evitando que el caso quede desatendido si hay personal operativo).
   */
  fallbackToAnyActive?: boolean;
  /**
   * Si es true, ignora el tope de casos concurrentes (para transferencias forzadas o casos críticos).
   */
  ignoreCapacityLimit?: boolean;
};

/**
 * Elige el agente humano que debe recibir un caso recién escalado dentro de
 * un departamento. Reglas:
 *
 * 1. Solo agentes `active` con `autoAssignEnabled`, actualmente conectados
 *    (`broadcaster.isUserConnected(id) === true`) y con `role` `agent` o
 *    `manager` (los `admin` no reciben carga operativa automática).
 *    Si un agente se desconecta o cierra sesión, queda estrictamente excluido
 *    del pool de asignación.
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

  async pickAgentForDepartment(
    departmentId: string,
    options?: AutoAssignOptions,
  ): Promise<Agent | null> {
    const allAgents = await this.deps.agentRepo.list();
    const roleEligible = allAgents.filter((a) => {
      if (!a.active || !a.autoAssignEnabled) return false;
      if (a.role !== "agent" && a.role !== "manager") return false;
      if (this.deps.broadcaster && !this.deps.broadcaster.isUserConnected(a.id)) {
        return false;
      }
      return true;
    });

    const eligible: Agent[] = [];
    for (const agent of roleEligible) {
      // Si el agente tiene definidas sus colas activas para su turno, solo es elegible
      // si este departamento esta en su lista activa.
      if (agent.activeDepartmentIds !== undefined) {
        if (agent.activeDepartmentIds.includes(departmentId)) {
          eligible.push(agent);
        }
        continue;
      }

      if (agent.primaryDepartmentId === departmentId) {
        eligible.push(agent);
        continue;
      }
      const belongs = await this.deps.agentRepo.belongsToDepartment(agent.id, departmentId);
      if (belongs) eligible.push(agent);
    }

    if (eligible.length === 0 && options?.fallbackToAnyActive) {
      const activeStaff = allAgents.filter(
        (a) => a.active && (a.role === "agent" || a.role === "manager"),
      );
      for (const agent of activeStaff) {
        if (agent.primaryDepartmentId === departmentId) {
          eligible.push(agent);
          continue;
        }
        const belongs = await this.deps.agentRepo.belongsToDepartment(agent.id, departmentId);
        if (belongs) eligible.push(agent);
      }
    }
    if (eligible.length === 0) return null;

    const loads = await this.deps.caseRepo.countActiveCasesByAgent(eligible.map((a) => a.id));

    // Despacho por capacidad concurrente (Concurrency Cap):
    // Si no se indica ignoreCapacityLimit, filtramos asesores que ya alcanzaron su cupo máximo.
    let candidates = eligible;
    if (!options?.ignoreCapacityLimit) {
      const dept = await this.deps.departmentRepo?.findById(departmentId);
      const maxConcurrency = dept?.maxConcurrentCases ?? this.deps.maxActiveCasesPerAgent ?? 6;
      candidates = eligible.filter((a) => (loads[a.id] ?? 0) < maxConcurrency);
      if (candidates.length === 0) {
        return null; // Todos los asesores en turno están copados a su capacidad máxima
      }
    }

    // Balanceo Equitativo Garantizado (Least-Connections):
    // Siempre se elige al agente con menor carga activa en ese instante.
    candidates.sort((a, b) => {
      const diff = (loads[a.id] ?? 0) - (loads[b.id] ?? 0);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, "es");
    });

    return candidates[0]!;
  }
}
