import type { Agent, AgentRole } from "../../domain/agent.entity";

export type CreateAgentInput = {
  name: string;
  email: string;
  role?: AgentRole;
  primaryDepartmentId?: string | null;
  /** Si se omite, el repo persiste `false` (opt-in). */
  autoAssignEnabled?: boolean;
  /** Hash argon2 ya calculado — nunca texto plano llega hasta aqui. */
  passwordHash?: string | null;
};

/** Todos los campos son opcionales: solo se actualiza lo presente en el patch. */
export type UpdateAgentPatch = Partial<{
  name: string;
  email: string;
  role: AgentRole;
  primaryDepartmentId: string | null;
  active: boolean;
  autoAssignEnabled: boolean;
  /** Hash argon2 ya calculado — nunca texto plano llega hasta aqui. */
  passwordHash: string | null;
}>;

export interface AgentRepositoryPort {
  list(): Promise<Agent[]>;
  findById(id: string): Promise<Agent | null>;
  /** Case-insensitive: el email siempre se compara/almacena normalizado a minusculas. */
  findByEmail(email: string): Promise<Agent | null>;
  create(input: CreateAgentInput): Promise<Agent>;
  update(id: string, patch: UpdateAgentPatch): Promise<Agent>;
  /**
   * Cuenta administradores activos, excluyendo opcionalmente uno (el que se
   * esta por modificar) — usado para impedir quedarse sin ningun admin activo.
   */
  countActiveAdmins(excludeAgentId?: string): Promise<number>;
  addMembership(agentId: string, departmentId: string): Promise<void>;
  belongsToDepartment(agentId: string, departmentId: string): Promise<boolean>;
  /** Departamentos con membership (alcance manager en calidad / triage). */
  listMembershipDepartmentIds(agentId: string): Promise<string[]>;
}
