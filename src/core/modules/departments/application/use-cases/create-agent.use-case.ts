import { businessError, validationError } from "../../../../../shared/errors/domain-errors";
import { generateTemporaryPassword, hashPassword } from "../../../../../shared/security/password-hasher";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Agent, AgentRole } from "../../domain/agent.entity";
import type { DepartmentRepositoryPort } from "../ports/department.repository.port";
import type { AgentRepositoryPort } from "../ports/agent.repository.port";

export type CreateAgentInput = {
  name: string;
  email: string;
  role?: AgentRole;
  primaryDepartmentId?: string | null;
  /** Admin que ejecuta el alta (para audit_event). */
  actorId: string;
};

export type CreateAgentDeps = {
  agentRepo: AgentRepositoryPort;
  departmentRepo: DepartmentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

export type CreateAgentResult = {
  agent: Agent;
  /**
   * Contrasena en texto plano — SOLO existe en el valor de retorno de esta
   * llamada (docs/spec/06_BACKEND_GAPS.md §1.b: decision de producto fue
   * generarla en el backend en vez de que el admin la escriba, porque el
   * proyecto no tiene infraestructura de correo para invitar al agente).
   * El router la devuelve una unica vez; nunca se puede volver a consultar
   * (ni siquiera un admin) — solo `POST /api/agents/:id/reset-password`.
   */
  temporaryPassword: string;
};

/**
 * docs/spec/06_BACKEND_GAPS.md §1 `POST /api/agents`. Restringido a
 * role=admin en la capa de presentation (agents-admin.router.ts).
 */
export class CreateAgentUseCase {
  constructor(private readonly deps: CreateAgentDeps) {}

  async execute(input: CreateAgentInput): Promise<CreateAgentResult> {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();

    if (name.length < 2) {
      throw validationError("El nombre del agente debe tener al menos 2 caracteres");
    }

    const existing = await this.deps.agentRepo.findByEmail(email);
    if (existing) {
      throw businessError(`Ya existe un agente con el correo ${email}`);
    }

    if (input.primaryDepartmentId) {
      const department = await this.deps.departmentRepo.findById(input.primaryDepartmentId);
      if (!department) {
        throw validationError(`El departamento ${input.primaryDepartmentId} no existe`);
      }
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    const agent = await this.deps.agentRepo.create({
      name,
      email,
      role: input.role ?? "agent",
      primaryDepartmentId: input.primaryDepartmentId ?? null,
      passwordHash,
    });

    await this.deps.auditRepo.record({
      action: "AGENT_CREATED",
      resourceType: "agent",
      resourceId: agent.id,
      actorId: input.actorId,
      metadata: { role: agent.role, primaryDepartmentId: agent.primaryDepartmentId },
    });
    this.deps.logger.info({ agentId: agent.id, actorId: input.actorId }, "agente creado");

    return { agent, temporaryPassword };
  }
}
