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
import type { UpdateAgentAvailabilityUseCase } from "../application/use-cases/update-agent-availability.use-case";
import type { AuditRepositoryPort } from "../../audit/application/ports/audit.repository.port";

export type AuthRouterDeps = {
  login: LoginUseCase;
  logout: LogoutUseCase;
  changePassword: ChangePasswordUseCase;
  updateAvailability: UpdateAgentAvailabilityUseCase;
  sessionTtlSeconds: number;
  auditRepo?: AuditRepositoryPort;
};

const loginBodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const availabilityBodySchema = z.object({
  autoAssignEnabled: z.boolean(),
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

      if (deps.auditRepo) {
        void deps.auditRepo
          .record({
            action: "AGENT_LOGIN",
            category: "security",
            resourceType: "auth",
            resourceId: agent.id,
            actorType: "agent",
            actorId: agent.id,
            departmentId: agent.primaryDepartmentId,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"] as string,
            correlationId: (req as unknown as { correlationId?: string }).correlationId,
            metadata: { email: agent.email },
          })
          .catch(() => undefined);
      }

      res.cookie(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(env, deps.sessionTtlSeconds));
      res.json({ data: toPublicAgentDto(agent) });
    } catch (error) {
      if (deps.auditRepo && req.body?.email) {
        void deps.auditRepo
          .record({
            action: "AGENT_LOGIN_FAILED",
            category: "security",
            resourceType: "auth",
            resourceId: String(req.body.email),
            actorType: "agent",
            actorId: null,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"] as string,
            correlationId: (req as unknown as { correlationId?: string }).correlationId,
            metadata: { email: req.body.email },
          })
          .catch(() => undefined);
      }
      next(error);
    }
  });

  router.post("/api/auth/logout", async (req, res, next) => {
    try {
      if (req.sessionToken) {
        await deps.logout.execute(req.sessionToken);
      }
      if (deps.auditRepo && req.agent) {
        void deps.auditRepo
          .record({
            action: "AGENT_LOGOUT",
            category: "security",
            resourceType: "auth",
            resourceId: req.agent.id,
            actorType: "agent",
            actorId: req.agent.id,
            departmentId: req.agent.primaryDepartmentId,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"] as string,
            correlationId: (req as unknown as { correlationId?: string }).correlationId,
          })
          .catch(() => undefined);
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

      if (deps.auditRepo) {
        void deps.auditRepo
          .record({
            action: "AGENT_PASSWORD_CHANGED",
            category: "security",
            resourceType: "agent",
            resourceId: agent.id,
            actorType: "agent",
            actorId: agent.id,
            departmentId: agent.primaryDepartmentId,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"] as string,
            correlationId: (req as unknown as { correlationId?: string }).correlationId,
          })
          .catch(() => undefined);
      }

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  const handleUpdateAvailability = async (
    req: Parameters<Parameters<typeof router.patch>[1]>[0],
    res: Parameters<Parameters<typeof router.patch>[1]>[1],
    next: Parameters<Parameters<typeof router.patch>[1]>[2],
  ) => {
    try {
      const agent = requireAuth(req);
      const parsed = availabilityBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }
      const updated = await deps.updateAvailability.execute({
        agentId: agent.id,
        autoAssignEnabled: parsed.data.autoAssignEnabled,
      });
      res.json({ data: toPublicAgentDto(updated) });
    } catch (error) {
      next(error);
    }
  };

  router.patch("/api/auth/me/availability", handleUpdateAvailability);
  router.put("/api/auth/me/availability", handleUpdateAvailability);

  return router;
}
