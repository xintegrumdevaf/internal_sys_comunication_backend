import { Router, type Response } from "express";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { AgentRepositoryPort } from "../../departments/application/ports/agent.repository.port";
import type { RealtimeBroadcaster, RealtimeEvent } from "../application/realtime-broadcaster";

export type RealtimeRouterDeps = {
  broadcaster: RealtimeBroadcaster;
  agentRepo: AgentRepositoryPort;
};

/**
 * SSE en `/api/realtime?userId=` (03_API_CONTRACT.md §C.3).
 * Identidad: query `userId` o header `x-agent-id` (mismo nivel que el resto del frontend).
 */
export function createRealtimeRouter(deps: RealtimeRouterDeps): Router {
  const router = Router();

  router.get("/api/realtime", async (req, res, next) => {
    try {
      const userId =
        (typeof req.query.userId === "string" && req.query.userId) ||
        req.header("x-agent-id") ||
        "";
      if (!userId) {
        throw validationError("userId (query) o header x-agent-id requerido");
      }

      const agent = await deps.agentRepo.findById(userId);
      if (!agent || !agent.active) {
        throw validationError("Agente no encontrado o inactivo");
      }

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
