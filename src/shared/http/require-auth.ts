import type { Request } from "express";
import { authorizationError } from "../errors/domain-errors";
import type { Agent, AgentRole } from "../../core/modules/departments/domain/agent.entity";

/**
 * A partir de docs/spec/06_BACKEND_GAPS.md §1.b, `req.agent` (poblado por
 * `session.middleware.ts` desde la cookie real) es la UNICA fuente de verdad
 * sobre quien esta haciendo una peticion — ya no se confia en `x-agent-id`
 * ni en `agentUserId`/`actorId` del body para decidir identidad (esos campos,
 * cuando siguen existiendo, son parametros de negocio como "a que agente
 * asignar", nunca una afirmacion de identidad).
 */
export function requireAuth(req: Request): Agent {
  if (!req.agent || !req.agent.active) {
    throw authorizationError("Debes iniciar sesion para usar esta funcion");
  }
  return req.agent;
}

export function requireRole(req: Request, roles: AgentRole[]): Agent {
  const agent = requireAuth(req);
  if (!roles.includes(agent.role)) {
    throw authorizationError(`Se requiere rol ${roles.join(" o ")} para esta accion`);
  }
  return agent;
}
