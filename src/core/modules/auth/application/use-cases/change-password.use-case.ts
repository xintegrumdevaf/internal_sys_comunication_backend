import { authorizationError, notFound, validationError } from "../../../../../shared/errors/domain-errors";
import { hashPassword, verifyPassword } from "../../../../../shared/security/password-hasher";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";

export type ChangePasswordInput = {
  agentId: string;
  currentPassword: string;
  newPassword: string;
};

export type ChangePasswordDeps = {
  agentRepo: AgentRepositoryPort;
  logger: Logger;
};

/**
 * docs/spec/06_BACKEND_GAPS.md §1.b `POST /api/auth/change-password` —
 * autoservicio: el propio agente cambia la contrasena temporal que le dio
 * el admin por una que solo el conoce. Requiere la contrasena actual (no
 * basta con estar logueado) para no dejar que una sesion robada la cambie
 * sin saber la contrasena real.
 */
export class ChangePasswordUseCase {
  constructor(private readonly deps: ChangePasswordDeps) {}

  async execute(input: ChangePasswordInput): Promise<void> {
    const agent = await this.deps.agentRepo.findById(input.agentId);
    if (!agent) {
      throw notFound(`Agente ${input.agentId} no encontrado`);
    }

    if (!agent.passwordHash || !(await verifyPassword(agent.passwordHash, input.currentPassword))) {
      throw authorizationError("La contraseña actual no es correcta");
    }

    if (input.newPassword.length < 8) {
      throw validationError("La nueva contraseña debe tener al menos 8 caracteres");
    }

    const passwordHash = await hashPassword(input.newPassword);
    await this.deps.agentRepo.update(agent.id, {
      passwordHash,
      mustChangePassword: false,
    });
    this.deps.logger.info({ agentId: agent.id }, "contraseña actualizada por el propio agente");
  }
}
