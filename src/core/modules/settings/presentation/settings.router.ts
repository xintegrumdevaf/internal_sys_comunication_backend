import { Router, type Request } from "express";
import { requireRole, requireAuth } from "../../../../shared/http/require-auth";
import { authorizationError } from "../../../../shared/errors/domain-errors";
import type { SystemSettingsService } from "../application/services/system-settings.service";
import type { DepartmentRepositoryPort } from "../../departments/application/ports/department.repository.port";
import type { Agent } from "../../departments/domain/agent.entity";
import type { Logger } from "../../../../shared/logging/logger";

export interface SettingsRouterDeps {
  settingsService: SystemSettingsService;
  logger: Logger;
  departmentRepo?: DepartmentRepositoryPort;
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const router = Router();
  const { settingsService, logger, departmentRepo } = deps;

  /**
   * GET /api/admin/settings
   * Consulta las configuraciones activas del sistema (con secretos enmascarados).
   * Exclusivo para administradores.
   */
  router.get("/api/admin/settings", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      const [channels, ai] = await Promise.all([
        settingsService.getMaskedChannelSettings(),
        settingsService.getMaskedAiSettings(),
      ]);
      res.json({
        success: true,
        data: {
          channels,
          ai,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/admin/settings/channels
   * Actualiza la configuración de canales (WhatsApp Cloud / Zernio).
   * Exclusivo para administradores.
   */
  router.put("/api/admin/settings/channels", async (req, res, next) => {
    try {
      const agent = requireRole(req, ["admin"]);
      const updated = await settingsService.updateChannelSettings(req.body, agent.id);
      logger.info({ agentId: agent.id }, "Canales de mensajería actualizados por admin");
      res.json({
        success: true,
        data: updated,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/admin/settings/ai
   * Actualiza la configuración del proveedor de IA (Gemini / Ollama) y modelos.
   * Exclusivo para administradores.
   */
  router.put("/api/admin/settings/ai", async (req, res, next) => {
    try {
      const agent = requireRole(req, ["admin"]);
      const updated = await settingsService.updateAiSettings(req.body, agent.id);
      logger.info({ agentId: agent.id }, "Configuración de IA actualizada por admin");
      res.json({
        success: true,
        data: updated,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/admin/settings/test-ai
   * Prueba en vivo la conexión con el proveedor de IA (Gemini u Ollama).
   * Exclusivo para administradores.
   */
  router.post("/api/admin/settings/test-ai", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      const result = await settingsService.testAiConnection(req.body);
      res.json({
        success: result.ok,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/admin/settings/ai/models
   * Consulta en tiempo real los modelos disponibles directamente desde la API del proveedor
   * (Google Gemini u Ollama) categorizados por costo, rendimiento y tipo.
   * Exclusivo para administradores.
   */
  router.post("/api/admin/settings/ai/models", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      const result = await settingsService.listCompatibleAiModels(req.body);
      res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  });


  /**
   * POST /api/admin/settings/test-channels
   * Prueba en vivo las credenciales del canal de mensajería (Meta Cloud API o Zernio).
   * Exclusivo para administradores.
   */
  router.post("/api/admin/settings/test-channels", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      const result = await settingsService.testChannelConnection(req.body);
      res.json({
        success: result.ok,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/admin/settings/setup-status
   * Consulta el estado general de configuración del sistema (onboarding/wizard).
   */
  router.get("/api/admin/settings/setup-status", async (req, res, next) => {
    try {
      requireAuth(req);
      const status = await settingsService.getSetupStatus();
      res.json({
        success: true,
        data: status,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Helper para comunicarse con el microservicio de red MikroTik (internal_sys_api_mikrotik).
   */
  const mikrotikBaseUrl = (process.env.MIKROTIK_SERVICE_URL || "http://localhost:3001/api").replace(/\/+$/, "");

  async function proxyMikrotik(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${mikrotikBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const msg = data?.message || data?.error?.message || `Error ${res.status} desde microservicio de red`;
      const err = new Error(msg);
      (err as any).statusCode = res.status;
      throw err;
    }
    return data;
  }

  /**
   * Valida acceso a infraestructura de red: reservado para Administradores y Gerentes de Soporte.
   */
  async function requireNetworkAccess(req: Request): Promise<Agent> {
    const agent = requireRole(req, ["admin", "manager"]);
    if (agent.role === "admin") {
      return agent;
    }

    // Si es manager, verificar si pertenece al área de soporte técnico
    if (departmentRepo) {
      const deptIds = new Set<string>();
      if (agent.primaryDepartmentId) deptIds.add(agent.primaryDepartmentId);
      if (agent.departmentIds) agent.departmentIds.forEach((id) => deptIds.add(id));

      if (deptIds.size > 0) {
        const allDepts = await departmentRepo.list();
        const isSupport = allDepts.some((d) => {
          const slug = (d.slug || "").toLowerCase();
          const name = (d.name || "").toLowerCase();
          const matchesSupport =
            slug === "support" ||
            slug === "soporte" ||
            slug === "soporte-tecnico" ||
            slug === "tecnico" ||
            name.includes("soporte") ||
            name.includes("support");
          return matchesSupport && deptIds.has(d.id);
        });
        if (isSupport) {
          return agent;
        }
      }
    } else {
      return agent;
    }

    throw authorizationError("Se requiere rol de administrador o gerente de soporte para gestionar la infraestructura de red");
  }

  // GET /api/admin/settings/network/routers
  router.get("/api/admin/settings/network/routers", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const data = await proxyMikrotik("/v1/network/routers");
      res.json({ success: true, data: data.routers || [] });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/settings/network/routers
  router.post("/api/admin/settings/network/routers", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const data = await proxyMikrotik("/v1/network/routers", {
        method: "POST",
        body: JSON.stringify(req.body),
      });
      res.status(201).json({ success: true, data: data.router });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/admin/settings/network/routers/:id
  router.put("/api/admin/settings/network/routers/:id", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const data = await proxyMikrotik(`/v1/network/routers/${req.params.id}`, {
        method: "PUT",
        body: JSON.stringify(req.body),
      });
      res.json({ success: true, data: data.router });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/admin/settings/network/routers/:id
  router.delete("/api/admin/settings/network/routers/:id", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      await proxyMikrotik(`/v1/network/routers/${req.params.id}`, {
        method: "DELETE",
      });
      res.json({ success: true, message: "Router eliminado" });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/settings/network/routers/:id/password
  router.get("/api/admin/settings/network/routers/:id/password", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const data = await proxyMikrotik(`/v1/network/routers/${req.params.id}/password`);
      res.json({ success: true, password: data.password });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/settings/network/routers/:routerId/olts
  router.post("/api/admin/settings/network/routers/:routerId/olts", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const data = await proxyMikrotik(`/v1/network/routers/${req.params.routerId}/olts`, {
        method: "POST",
        body: JSON.stringify(req.body),
      });
      res.status(201).json({ success: true, data: data.olt });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/admin/settings/network/routers/:routerId/olts/:oltId
  router.put("/api/admin/settings/network/routers/:routerId/olts/:oltId", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const data = await proxyMikrotik(`/v1/network/routers/${req.params.routerId}/olts/${req.params.oltId}`, {
        method: "PUT",
        body: JSON.stringify(req.body),
      });
      res.json({ success: true, data: data.olt });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/admin/settings/network/routers/:routerId/olts/:oltId
  router.delete("/api/admin/settings/network/routers/:routerId/olts/:oltId", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      await proxyMikrotik(`/v1/network/routers/${req.params.routerId}/olts/${req.params.oltId}`, {
        method: "DELETE",
      });
      res.json({ success: true, message: "OLT eliminada" });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/settings/network/routers/:routerId/olts/:oltId/password
  router.get("/api/admin/settings/network/routers/:routerId/olts/:oltId/password", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const data = await proxyMikrotik(`/v1/network/routers/${req.params.routerId}/olts/${req.params.oltId}/password`);
      res.json({ success: true, password: data.password });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/settings/network/test-connection
  router.post("/api/admin/settings/network/test-connection", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const result = await proxyMikrotik("/v1/network/test-connection", {
        method: "POST",
        body: JSON.stringify(req.body),
      });
      res.json({ success: result.success, data: result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
