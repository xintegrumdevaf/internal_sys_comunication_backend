import { authorizationError } from "../../../../../shared/errors/domain-errors";
import { verifyPassword } from "../../../../../shared/security/password-hasher";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Agent } from "../../../departments/domain/agent.entity";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { Session } from "../../domain/session.entity";
import type { SessionStorePort } from "../ports/session-store.port";

export type LoginInput = { email: string; password: string };

export type LoginDeps = {
  agentRepo: AgentRepositoryPort;
  sessionStore: SessionStorePort;
  sessionTtlSeconds: number;
  logger: Logger;
};

/**
 * docs/spec/06_BACKEND_GAPS.md §1.b `POST /api/auth/login`. El mensaje de
 * error es siempre el mismo genérico (correo no existe, agente inactivo,
 * sin contrasena configurada, o contrasena incorrecta) — nunca se le dice a
 * quien no ha entrado todavia CUAL de esas cosas fallo (evita que alguien
 * pueda "tantear" que correos existen en el sistema).
 */
export class LoginUseCase {
  constructor(private readonly deps: LoginDeps) {}

  async execute(input: LoginInput): Promise<{ agent: Agent; session: Session }> {
    const email = input.email.trim().toLowerCase();
    const agent = await this.deps.agentRepo.findByEmail(email);

    if (!agent || !agent.active || !agent.passwordHash) {
      throw authorizationError("Correo o contraseña incorrectos");
    }

    const validPassword = await verifyPassword(agent.passwordHash, input.password);
    if (!validPassword) {
      throw authorizationError("Correo o contraseña incorrectos");
    }

    const session = await this.deps.sessionStore.create(agent.id, this.deps.sessionTtlSeconds);
    this.deps.logger.info({ agentId: agent.id }, "login exitoso");

    return { agent, session };
  }
}
