import { Router, type Request } from "express";
import { requireRole, requireAuth } from "../../../../shared/http/require-auth";
import { authorizationError, validationError } from "../../../../shared/errors/domain-errors";
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

  // POST /api/admin/settings/network/import
  // Permite subir un archivo o payload JSON directamente desde el Frontend con la topología completa
  router.post("/api/admin/settings/network/import", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);

      const rawRouters = Array.isArray(req.body)
        ? req.body
        : Array.isArray(req.body?.routers)
          ? req.body.routers
          : null;

      if (!rawRouters || rawRouters.length === 0) {
        throw validationError("El cuerpo o archivo debe contener un arreglo de 'routers'");
      }

      // 1. Consultar routers existentes en el microservicio para evitar duplicados
      const listData = await proxyMikrotik("/v1/network/routers").catch(() => ({ routers: [] }));
      const existingRouters = (listData.routers || listData.data || []) as Array<{
        id: string;
        name: string;
        sector?: string;
        olts?: Array<{ id: string; name: string }>;
      }>;

      const results: Array<{
        routerName: string;
        routerId: string;
        status: "created" | "existing";
        olts: Array<{ oltName: string; status: "created" | "existing" | "error" }>;
      }> = [];

      for (const item of rawRouters) {
        const routerHost = item.host || item.ip;
        if (!item.name || !routerHost) continue;

        let routerId = "";
        let status: "created" | "existing" = "existing";

        const existing = existingRouters.find(
          (r) =>
            r.name.toLowerCase() === item.name.toLowerCase() ||
            (item.sector && r.sector && r.sector.toLowerCase() === item.sector.toLowerCase()) ||
            (item.displayName && r.name && r.name.toLowerCase() === item.displayName.toLowerCase())
        );

        if (existing) {
          routerId = existing.id;
        } else {
          const created = await proxyMikrotik("/v1/network/routers", {
            method: "POST",
            body: JSON.stringify({
              name: item.name,
              displayName: item.displayName || item.sector || item.name,
              host: routerHost,
              port: item.port ?? 8322,
              username: item.username || item.user || "ANGEL",
              password: item.password,
            }),
          });
          routerId = created.router?.id || created.data?.id || "";
          status = "created";
        }

        const oltResults: Array<{ oltName: string; status: "created" | "existing" | "error" }> = [];

        if (routerId && Array.isArray(item.olts)) {
          const currentOlts = existing?.olts || [];
          for (const olt of item.olts) {
            const oltIp = olt.ip || olt.host;
            if (!olt.name || !oltIp) continue;

            const oltExists = currentOlts.some(
              (o) => o.name.toLowerCase() === olt.name.toLowerCase()
            );

            if (oltExists) {
              oltResults.push({ oltName: olt.name, status: "existing" });
            } else {
              try {
                await proxyMikrotik(`/v1/network/routers/${routerId}/olts`, {
                  method: "POST",
                  body: JSON.stringify({
                    name: olt.name,
                    displayName: olt.displayName || `OLT ${olt.name}`,
                    ip: oltIp,
                    brand: (olt.brand || "huawei").toLowerCase(),
                    username: olt.username || olt.user || "admin",
                    password: olt.password,
                    slot: olt.slot,
                  }),
                });
                oltResults.push({ oltName: olt.name, status: "created" });
              } catch {
                oltResults.push({ oltName: olt.name, status: "error" });
              }
            }
          }
        }

        results.push({
          routerName: item.name,
          routerId,
          status,
          olts: oltResults,
        });
      }

      res.status(200).json({
        success: true,
        message: `Importación completada: ${results.length} routers procesados`,
        data: results,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/settings/network/export
  // Exporta la topología actual completa con contraseñas descifradas para administradores autorizados
  router.get("/api/admin/settings/network/export", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const data = await proxyMikrotik("/v1/network/routers");
      const routers = (data.routers || data.data || []) as any[];

      // Resolver contraseñas descifradas para que el archivo sea un backup completo e importable
      const fullRouters = await Promise.all(
        routers.map(async (router) => {
          let routerPassword = router.password || "";
          if (router.id) {
            try {
              const passData = await proxyMikrotik(`/v1/network/routers/${router.id}/password`);
              if (passData && passData.password) {
                routerPassword = passData.password;
              }
            } catch {
              // Mantener valor previo si falla
            }
          }

          const olts = Array.isArray(router.olts)
            ? await Promise.all(
                router.olts.map(async (olt: any) => {
                  let oltPassword = olt.password || "";
                  if (router.id && olt.id) {
                    try {
                      const oltPassData = await proxyMikrotik(
                        `/v1/network/routers/${router.id}/olts/${olt.id}/password`
                      );
                      if (oltPassData && oltPassData.password) {
                        oltPassword = oltPassData.password;
                      }
                    } catch {
                      // Mantener valor previo si falla
                    }
                  }
                  return {
                    ...olt,
                    password: oltPassword,
                  };
                })
              )
            : [];

          return {
            ...router,
            password: routerPassword,
            olts,
          };
        })
      );

      res.json({
        success: true,
        data: {
          exportedAt: new Date().toISOString(),
          routers: fullRouters,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
