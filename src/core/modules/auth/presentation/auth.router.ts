import { Router } from "express";
import { z } from "zod";
import { validationError } from "../../../../shared/errors/domain-errors";
import { env } from "../../../../shared/config/env";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "../../../../shared/http/cookies";
import { requireAuth } from "../../../../shared/http/require-auth";
import { toPublicAgentDto } from "../../departments/presentation/agent-dto.mapper";
import type { LoginUseCase } from "../application/use-cases/login.use-case";
import type { LogoutUseCase } from "../application/use-cases/logout.use-case";
import type { ChangePasswordUseCase } from "../application/use-cases/change-password.use-case";

export type AuthRouterDeps = {
  login: LoginUseCase;
  logout: LogoutUseCase;
  changePassword: ChangePasswordUseCase;
  sessionTtlSeconds: number;
};

const loginBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

/**
 * docs/spec/06_BACKEND_GAPS.md §1.b — login con credenciales reales.
 * Estas 4 rutas son las UNICAS de todo el backend que no requieren sesion
 * previa via `requireAuth` (login obviamente no puede exigirla; logout y
 * me/change-password si la exigen, pero cada una lo hace explicito abajo).
 */
export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();

  router.post("/api/auth/login", async (req, res, next) => {
    try {
      const parsed = loginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }
      const { agent, session } = await deps.login.execute(parsed.data);
      res.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(env, deps.sessionTtlSeconds));
      res.json({ data: toPublicAgentDto(agent) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/auth/logout", async (req, res, next) => {
    try {
      if (req.sessionToken) {
        await deps.logout.execute(req.sessionToken);
      }
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/auth/me", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      res.json({ data: toPublicAgentDto(agent) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/auth/change-password", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const parsed = changePasswordBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }
      await deps.changePassword.execute({ agentId: agent.id, ...parsed.data });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
