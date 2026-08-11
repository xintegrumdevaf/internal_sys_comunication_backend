import { Router, type Response } from "express";
import { requireAuth } from "../../../../shared/http/require-auth";
import type { RealtimeBroadcaster, RealtimeEvent } from "../application/realtime-broadcaster";

export type RealtimeRouterDeps = {
  broadcaster: RealtimeBroadcaster;
};

/**
 * SSE en `/api/realtime` (03_API_CONTRACT.md §C.3). Identidad via sesion
 * real (docs/spec/06_BACKEND_GAPS.md §1.b): `EventSource` no puede mandar
 * headers propios, pero si manda la cookie httpOnly con
 * `withCredentials: true` — por eso `session.middleware.ts` ya resolvio
 * `req.agent` antes de llegar aqui, igual que cualquier otro endpoint.
 */
export function createRealtimeRouter(deps: RealtimeRouterDeps): Router {
  const router = Router();

  router.get("/api/realtime", async (req, res, next) => {
    try {
      const agent = requireAuth(req);
      const userId = agent.id;

      const departmentIds = new Set<string>();
      if (agent.primaryDepartmentId) departmentIds.add(agent.primaryDepartmentId);

      // Memberships: el port no lista todos; primary + admin/manager basta para Etapa 7.
      // Si el agente tiene primary, filtramos CASE_ESCALATED por ese depto.

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const send = (event: RealtimeEvent): void => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      res.write(`: connected userId=${userId}\n\n`);

      const unsubscribe = deps.broadcaster.subscribe({
        userId: agent.id,
        departmentIds,
        role: agent.role,
        send,
      });

      const keepAlive = setInterval(() => {
        res.write(`: ping\n\n`);
      }, 25000);

      req.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/** Helper de test: escribe un evento SSE en un Response mockeable. */
export function writeSseEvent(res: Response, event: RealtimeEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
