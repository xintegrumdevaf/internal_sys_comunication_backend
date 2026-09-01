import {
  authorizationError,
  notFound,
} from "../../../../../shared/errors/domain-errors";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { Case } from "../../../cases/domain/case.entity";
import { validationError } from "../../../../../shared/errors/domain-errors";

export async function resolveActingAgent(
  agentRepo: AgentRepositoryPort,
  agentUserId: string,
): Promise<Agent> {
  if (!agentUserId) {
    throw validationError("agentUserId requerido");
  }
  const agent = await agentRepo.findById(agentUserId);
  if (!agent || !agent.active) {
    throw notFound(`Agente ${agentUserId} no encontrado o inactivo`);
  }
  return agent;
}

/**
 * Reglas de escritura (01_DATA_MODEL.md §7 + 03_API_CONTRACT.md §C.2).
 */
export async function assertCanWriteCase(input: {
  agent: Agent;
  caseEntity: Case;
  mode: "claim" | "act";
  agentRepo: AgentRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
}): Promise<void> {
  const { agent, caseEntity, mode, agentRepo, departmentRepo } = input;

  if (agent.role === "admin") return;

  // Si el agente ya es el dueño asignado del caso, siempre puede actuar sobre él
  if (mode === "act" && caseEntity.assignedAgentId === agent.id) {
    return;
  }

  // Caso en pool de triage (sin departamento):
  if (caseEntity.departmentId === null) {
    // Reclamar está permitido para cualquier agente autenticado o manager/admin
    if (mode === "claim") {
      return;
    }
    // Para actuar sobre un caso de triage que no está asignado a este agente se requiere manager o admin
    if (agent.role !== "manager") {
      throw authorizationError("El pool de triage solo es accesible para manager o admin");
    }
    return;
  }

  const department = await departmentRepo.findById(caseEntity.departmentId);
  if (!department) {
    throw notFound(`Departamento ${caseEntity.departmentId} no encontrado`);
  }

  if (department.visibility === "restricted") {
    const belongs = await agentRepo.belongsToDepartment(agent.id, department.id);
    if (!belongs && agent.primaryDepartmentId !== department.id) {
      throw authorizationError("Sin membership en departamento restricted");
    }
  }

  if (mode === "claim") {
    // claim: caso sin asignar; visibilidad shared/restricted ya validada.
    return;
  }

  // act (reply / disable / etc.): dueño o manager del depto.
  if (caseEntity.assignedAgentId === agent.id) return;
  if (caseEntity.assignedAgentId === null) {
    throw authorizationError("El caso no está reclamado; usa claim primero");
  }
  if (agent.role === "manager") {
    const belongs = await agentRepo.belongsToDepartment(agent.id, department.id);
    if (belongs || agent.primaryDepartmentId === department.id) return;
  }
  throw authorizationError("No puedes actuar sobre un caso asignado a otro agente");
}

export async function assertCanReadEscalation(input: {
  agent: Agent;
  departmentId: string | null;
  agentRepo: AgentRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
}): Promise<void> {
  const { agent, departmentId, agentRepo, departmentRepo } = input;
  if (agent.role === "admin") return;

  if (departmentId === null) {
    if (agent.role !== "manager") {
      throw authorizationError("Pool de triage visible solo para manager o admin");
    }
    return;
  }

  const department = await departmentRepo.findById(departmentId);
  if (!department) throw notFound(`Departamento ${departmentId} no encontrado`);
  if (department.visibility === "shared") return;

  const belongs = await agentRepo.belongsToDepartment(agent.id, department.id);
  if (!belongs && agent.primaryDepartmentId !== department.id) {
    throw authorizationError("Sin acceso de lectura al departamento restricted");
  }
}
