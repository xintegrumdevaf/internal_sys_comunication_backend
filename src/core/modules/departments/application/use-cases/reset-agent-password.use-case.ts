import { notFound, validationError } from "../../../../../shared/errors/domain-errors";
import { generateTemporaryPassword, hashPassword } from "../../../../../shared/security/password-hasher";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { Agent } from "../../domain/agent.entity";
import type { AgentRepositoryPort } from "../ports/agent.repository.port";

export type ResetAgentPasswordInput = {
  agentId: string;
  /** Admin que ejecuta el reinicio (para audit_event). */
  actorId: string;
  /**
   * Opcional: contrasena manual elegida por el admin (min 8 chars).
   * Si no se proporciona, se autogenera una clave temporal segura.
   */
  password?: string;
  /**
   * Opcional: si se fuerza al agente a cambiarla en su proximo login (default `true`).
   */
  mustChangePassword?: boolean;
};

export type ResetAgentPasswordDeps = {
  agentRepo: AgentRepositoryPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
};

export type ResetAgentPasswordResult = {
  agent: Agent;
  /** Ver comentario en create-agent.use-case.ts — solo se ve una vez. */
  temporaryPassword: string;
};

/**
 * docs/spec/06_BACKEND_GAPS.md §1.b `POST /api/agents/:id/reset-password`.
 * Es la unica forma de que un agente creado ANTES de esta migracion (sin
 * contrasena) o que olvido la suya, pueda volver a entrar — restringido a
 * role=admin en la capa de presentation.
 */
export class ResetAgentPasswordUseCase {
  constructor(private readonly deps: ResetAgentPasswordDeps) {}

  async execute(input: ResetAgentPasswordInput): Promise<ResetAgentPasswordResult> {
    const agent = await this.deps.agentRepo.findById(input.agentId);
    if (!agent) {
      throw notFound(`Agente ${input.agentId} no encontrado`);
    }

    if (input.password !== undefined && input.password.trim().length < 8) {
      throw validationError("La contraseña debe tener al menos 8 caracteres");
    }

    const temporaryPassword = input.password?.trim() || generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const mustChangePassword = input.mustChangePassword ?? true;

    const updated = await this.deps.agentRepo.update(agent.id, {
      passwordHash,
      mustChangePassword,
    });

    await this.deps.auditRepo.record({
      action: "AGENT_PASSWORD_RESET",
      resourceType: "agent",
      resourceId: agent.id,
      actorId: input.actorId,
      metadata: {
        manualPasswordProvided: input.password !== undefined,
        mustChangePassword,
      },
    });
    this.deps.logger.info(
      { agentId: agent.id, actorId: input.actorId, mustChangePassword },
      "contraseña restablecida por admin",
    );

    return { agent: updated, temporaryPassword };
  }
}
