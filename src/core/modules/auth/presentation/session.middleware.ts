import type { NextFunction, Request, Response } from "express";
import { env } from "../../../../shared/config/env";
import { parseCookies, SESSION_COOKIE_NAME, sessionCookieOptions } from "../../../../shared/http/cookies";
import type { AgentRepositoryPort } from "../../departments/application/ports/agent.repository.port";
import type { SessionStorePort } from "../application/ports/session-store.port";

export type SessionMiddlewareDeps = {
  sessionStore: SessionStorePort;
  agentRepo: AgentRepositoryPort;
  sessionTtlSeconds: number;
};

/**
 * Corre en TODAS las requests (excepto health/webhook de WhatsApp) y pobla
 * `req.agent` a partir de la cookie real — reemplaza la confianza ciega en
 * `x-agent-id` de docs/spec/06_BACKEND_GAPS.md §1.b. No bloquea nada por si
 * sola (deja `req.agent = null` si no hay sesion valida); cada router decide
 * con `requireAuth`/`requireRole` (shared/http/require-auth.ts) si la ruta
 * necesita identidad.
 *
 * Expiracion deslizante: cada request autenticado renueva el TTL en Redis Y
 * el `Max-Age` de la cookie, para que "12 horas" signifique "12 horas desde
 * la ULTIMA actividad", no desde el login.
 */
export function createSessionMiddleware(deps: SessionMiddlewareDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    req.agent = null;
    req.sessionToken = null;

    const token = parseCookies(req.header("cookie"))[SESSION_COOKIE_NAME];
    if (!token) {
      next();
      return;
    }

    try {
      const session = await deps.sessionStore.touch(token, deps.sessionTtlSeconds);
      if (!session) {
        next();
        return;
      }
      const agent = await deps.agentRepo.findById(session.agentId);
      if (agent && agent.active) {
        req.agent = agent;
        req.sessionToken = token;
        res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(env, deps.sessionTtlSeconds));
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
