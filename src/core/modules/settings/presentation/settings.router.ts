import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import net from "node:net";
import multer from "multer";
import { requireRole, requireAuth } from "../../../../shared/http/require-auth";
import { authorizationError, notFound, validationError } from "../../../../shared/errors/domain-errors";
import type { SystemSettingsService } from "../application/services/system-settings.service";
import type { DepartmentRepositoryPort } from "../../departments/application/ports/department.repository.port";
import type { Agent } from "../../departments/domain/agent.entity";
import type { Logger } from "../../../../shared/logging/logger";

const uploadTopology = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

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
      const localRouters = await settingsService.getNetworkTopology();
      try {
        const data = await proxyMikrotik("/v1/network/routers");
        const remoteRouters = (
          Array.isArray(data) ? data : data.routers || data.data || []
        ) as Record<string, any>[];
        if (remoteRouters.length > 0) {
          // Combinar contraseñas/metadatos locales con los routers remotos
          const merged: Record<string, any>[] = remoteRouters.map((rem): Record<string, any> => {
            const loc = localRouters.find(
              (l) =>
                l.id === rem.id ||
                String(l.name || "").toLowerCase() === String(rem.name || "").toLowerCase(),
            );
            return {
              ...loc,
              ...rem,
              ip: rem.ip || rem.host || loc?.ip || loc?.host || "",
              host: rem.host || rem.ip || loc?.host || loc?.ip || "",
              user: rem.user || rem.username || loc?.user || loc?.username || "admin",
              username: rem.username || rem.user || loc?.username || loc?.user || "admin",
              olts: Array.isArray(rem.olts) && rem.olts.length > 0 ? rem.olts : loc?.olts || [],
            };
          });
          for (const loc of localRouters) {
            const inMerged = merged.some(
              (m) =>
                m.id === loc.id ||
                String(m.name || "").toLowerCase() === String(loc.name || "").toLowerCase(),
            );
            if (!inMerged) {
              merged.push(loc);
            }
          }
          await settingsService.saveNetworkTopology(merged);
          res.json({ success: true, data: merged });
          return;
        }
      } catch (err) {
        logger.warn({ err }, "Microservicio de red no disponible en GET /routers; usando topología persistida en BD");
      }

      res.json({ success: true, data: localRouters });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/settings/network/routers
  router.post("/api/admin/settings/network/routers", async (req, res, next) => {
    try {
      const agent = await requireNetworkAccess(req);
      const body = req.body || {};
      const host = body.host || body.ip || "";
      if (!body.name || !host) {
        throw validationError("El router requiere al menos 'name' y 'host' (o 'ip')");
      }

      let remoteRouter: Record<string, any> | null = null;
      try {
        const data = await proxyMikrotik("/v1/network/routers", {
          method: "POST",
          body: JSON.stringify({
            ...body,
            displayName: body.displayName || body.sector || body.name,
            host,
            ip: host,
            port: body.port ?? 8728,
            username: body.username || body.user || "admin",
          }),
        });
        remoteRouter = data.router || data.data || null;
      } catch (err) {
        logger.warn({ err }, "Microservicio de red no disponible al crear router; guardando localmente en BD");
      }

      const localRouters = [...(await settingsService.getNetworkTopology())];
      const newRouter: Record<string, any> = {
        id: remoteRouter?.id || body.id || randomUUID(),
        name: body.name,
        displayName: body.displayName || body.sector || body.name,
        sector: body.sector || body.displayName || body.name,
        host,
        ip: host,
        port: Number(body.port ?? 8728),
        username: body.username || body.user || "admin",
        user: body.user || body.username || "admin",
        password: body.password || "",
        description: body.description || "",
        active: body.active ?? true,
        olts: Array.isArray(remoteRouter?.olts)
          ? remoteRouter.olts
          : Array.isArray(body.olts)
            ? body.olts
            : [],
        ...(remoteRouter || {}),
      };

      const existingIdx = localRouters.findIndex(
        (r) =>
          r.id === newRouter.id ||
          String(r.name || "").toLowerCase() === String(newRouter.name || "").toLowerCase(),
      );
      if (existingIdx >= 0) {
        localRouters[existingIdx] = newRouter;
      } else {
        localRouters.push(newRouter);
      }
      await settingsService.saveNetworkTopology(localRouters, agent.id);

      res.status(201).json({ success: true, data: newRouter });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/admin/settings/network/routers/:id
  router.put("/api/admin/settings/network/routers/:id", async (req, res, next) => {
    try {
      const agent = await requireNetworkAccess(req);
      const routerId = String(req.params.id);
      const body = req.body || {};

      let remoteRouter: Record<string, any> | null = null;
      try {
        const data = await proxyMikrotik(`/v1/network/routers/${routerId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        remoteRouter = data.router || data.data || null;
      } catch (err) {
        logger.warn({ err, routerId }, "Microservicio de red no disponible al actualizar router; actualizando en BD");
      }

      const localRouters = [...(await settingsService.getNetworkTopology())];
      const idx = localRouters.findIndex((r) => String(r.id) === routerId);
      const current = idx >= 0 ? localRouters[idx]! : { id: routerId, olts: [] };
      const host = body.host || body.ip || current.host || current.ip || "";

      const updatedRouter: Record<string, any> = {
        ...current,
        ...body,
        ...(remoteRouter || {}),
        id: routerId,
        host,
        ip: host,
        username: body.username || body.user || current.username || current.user || "admin",
        user: body.user || body.username || current.user || current.username || "admin",
        password: body.password !== undefined && body.password !== "" ? body.password : current.password || "",
        olts: Array.isArray(remoteRouter?.olts)
          ? remoteRouter.olts
          : Array.isArray(body.olts)
            ? body.olts
            : current.olts || [],
      };

      if (idx >= 0) {
        localRouters[idx] = updatedRouter;
      } else {
        localRouters.push(updatedRouter);
      }
      await settingsService.saveNetworkTopology(localRouters, agent.id);

      res.json({ success: true, data: updatedRouter });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/admin/settings/network/routers/:id
  router.delete("/api/admin/settings/network/routers/:id", async (req, res, next) => {
    try {
      const agent = await requireNetworkAccess(req);
      const routerId = String(req.params.id);
      try {
        await proxyMikrotik(`/v1/network/routers/${routerId}`, {
          method: "DELETE",
        });
      } catch (err) {
        logger.warn({ err, routerId }, "Microservicio de red no disponible al eliminar router; eliminando de BD");
      }

      const localRouters = (await settingsService.getNetworkTopology()).filter(
        (r) => String(r.id) !== routerId,
      );
      await settingsService.saveNetworkTopology(localRouters, agent.id);

      res.json({ success: true, message: "Router eliminado" });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/settings/network/routers/:id/password
  router.get("/api/admin/settings/network/routers/:id/password", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const routerId = String(req.params.id);
      try {
        const data = await proxyMikrotik(`/v1/network/routers/${routerId}/password`);
        if (data?.password !== undefined) {
          res.json({ success: true, password: data.password });
          return;
        }
      } catch {
        // Fallback a topología local en BD
      }
      const localRouters = await settingsService.getNetworkTopology();
      const found = localRouters.find((r) => String(r.id) === routerId);
      res.json({ success: true, password: found?.password || "" });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/settings/network/routers/:routerId/olts
  router.post("/api/admin/settings/network/routers/:routerId/olts", async (req, res, next) => {
    try {
      const agent = await requireNetworkAccess(req);
      const routerId = String(req.params.routerId);
      const body = req.body || {};
      const oltIp = body.ip || body.host || "";
      if (!body.name || !oltIp) {
        throw validationError("La OLT requiere al menos 'name' e 'ip'");
      }

      let remoteOlt: Record<string, any> | null = null;
      try {
        const data = await proxyMikrotik(`/v1/network/routers/${routerId}/olts`, {
          method: "POST",
          body: JSON.stringify({
            ...body,
            displayName: body.displayName || `OLT ${body.name}`,
            ip: oltIp,
            brand: (body.brand || "huawei").toLowerCase(),
            username: body.username || body.user || "admin",
          }),
        });
        remoteOlt = data.olt || data.data || null;
      } catch (err) {
        logger.warn({ err, routerId }, "Microservicio de red no disponible al crear OLT; guardando en BD");
      }

      const localRouters = [...(await settingsService.getNetworkTopology())];
      const rIdx = localRouters.findIndex((r) => String(r.id) === routerId);
      if (rIdx < 0 && !remoteOlt) {
        throw notFound(`No se encontró el router '${routerId}'`);
      }

      const newOlt: Record<string, any> = {
        id: remoteOlt?.id || body.id || randomUUID(),
        name: body.name,
        displayName: body.displayName || `OLT ${body.name}`,
        ip: oltIp,
        host: oltIp,
        brand: (body.brand || "huawei").toLowerCase(),
        model: body.model || "",
        port: Number(body.port ?? 23),
        username: body.username || body.user || "admin",
        user: body.user || body.username || "admin",
        password: body.password || "",
        slot: body.slot,
        ponPorts: Number(body.ponPorts ?? 8),
        ...(remoteOlt || {}),
      };

      if (rIdx >= 0) {
        const routerObj = { ...localRouters[rIdx]! };
        const olts = Array.isArray(routerObj.olts) ? [...routerObj.olts] : [];
        const existingOltIdx = olts.findIndex(
          (o: any) =>
            o.id === newOlt.id ||
            String(o.name || "").toLowerCase() === String(newOlt.name || "").toLowerCase(),
        );
        if (existingOltIdx >= 0) {
          olts[existingOltIdx] = newOlt;
        } else {
          olts.push(newOlt);
        }
        routerObj.olts = olts;
        localRouters[rIdx] = routerObj;
        await settingsService.saveNetworkTopology(localRouters, agent.id);
      }

      res.status(201).json({ success: true, data: newOlt });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/admin/settings/network/routers/:routerId/olts/:oltId
  router.put("/api/admin/settings/network/routers/:routerId/olts/:oltId", async (req, res, next) => {
    try {
      const agent = await requireNetworkAccess(req);
      const routerId = String(req.params.routerId);
      const oltId = String(req.params.oltId);
      const body = req.body || {};

      let remoteOlt: Record<string, any> | null = null;
      try {
        const data = await proxyMikrotik(`/v1/network/routers/${routerId}/olts/${oltId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        remoteOlt = data.olt || data.data || null;
      } catch (err) {
        logger.warn({ err, routerId, oltId }, "Microservicio de red no disponible al actualizar OLT; actualizando en BD");
      }

      const localRouters = [...(await settingsService.getNetworkTopology())];
      const rIdx = localRouters.findIndex((r) => String(r.id) === routerId);
      let updatedOlt: Record<string, any> = { id: oltId, ...body, ...(remoteOlt || {}) };

      if (rIdx >= 0) {
        const routerObj = { ...localRouters[rIdx]! };
        const olts = Array.isArray(routerObj.olts) ? [...routerObj.olts] : [];
        const oIdx = olts.findIndex((o: any) => String(o.id) === oltId);
        const currentOlt = oIdx >= 0 ? olts[oIdx]! : { id: oltId };
        const oltIp = body.ip || body.host || currentOlt.ip || currentOlt.host || "";

        updatedOlt = {
          ...currentOlt,
          ...body,
          ...(remoteOlt || {}),
          id: oltId,
          ip: oltIp,
          host: oltIp,
          username: body.username || body.user || currentOlt.username || currentOlt.user || "admin",
          user: body.user || body.username || currentOlt.user || currentOlt.username || "admin",
          password:
            body.password !== undefined && body.password !== ""
              ? body.password
              : currentOlt.password || "",
        };

        if (oIdx >= 0) {
          olts[oIdx] = updatedOlt;
        } else {
          olts.push(updatedOlt);
        }
        routerObj.olts = olts;
        localRouters[rIdx] = routerObj;
        await settingsService.saveNetworkTopology(localRouters, agent.id);
      }

      res.json({ success: true, data: updatedOlt });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/admin/settings/network/routers/:routerId/olts/:oltId
  router.delete("/api/admin/settings/network/routers/:routerId/olts/:oltId", async (req, res, next) => {
    try {
      const agent = await requireNetworkAccess(req);
      const routerId = String(req.params.routerId);
      const oltId = String(req.params.oltId);
      try {
        await proxyMikrotik(`/v1/network/routers/${routerId}/olts/${oltId}`, {
          method: "DELETE",
        });
      } catch (err) {
        logger.warn({ err, routerId, oltId }, "Microservicio de red no disponible al eliminar OLT; eliminando de BD");
      }

      const localRouters = [...(await settingsService.getNetworkTopology())];
      const rIdx = localRouters.findIndex((r) => String(r.id) === routerId);
      if (rIdx >= 0) {
        const routerObj = { ...localRouters[rIdx]! };
        routerObj.olts = (Array.isArray(routerObj.olts) ? routerObj.olts : []).filter(
          (o: any) => String(o.id) !== oltId,
        );
        localRouters[rIdx] = routerObj;
        await settingsService.saveNetworkTopology(localRouters, agent.id);
      }

      res.json({ success: true, message: "OLT eliminada" });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/admin/settings/network/routers/:routerId/olts/:oltId/password
  router.get("/api/admin/settings/network/routers/:routerId/olts/:oltId/password", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const routerId = String(req.params.routerId);
      const oltId = String(req.params.oltId);
      try {
        const data = await proxyMikrotik(`/v1/network/routers/${routerId}/olts/${oltId}/password`);
        if (data?.password !== undefined) {
          res.json({ success: true, password: data.password });
          return;
        }
      } catch {
        // Fallback a topología local en BD
      }

      const localRouters = await settingsService.getNetworkTopology();
      const routerObj = localRouters.find((r) => String(r.id) === routerId);
      const oltObj = (Array.isArray(routerObj?.olts) ? routerObj.olts : []).find(
        (o: any) => String(o.id) === oltId,
      );
      res.json({ success: true, password: oltObj?.password || "" });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/settings/network/test-connection
  router.post("/api/admin/settings/network/test-connection", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      try {
        const result = await proxyMikrotik("/v1/network/test-connection", {
          method: "POST",
          body: JSON.stringify(req.body),
        });
        res.json({ success: result.success, data: result });
        return;
      } catch {
        // Fallback: prueba de socket TCP directa desde el backend si el microservicio de red está apagado
        const host = req.body?.host || req.body?.ip;
        const port = Number(req.body?.port || 8728);
        if (!host) {
          throw validationError("Debe especificar 'host' o 'ip' para probar la conexión");
        }
        const start = Date.now();
        const tcpResult = await new Promise<{ success: boolean; latencyMs: number; message: string }>((resolve) => {
          const socket = new net.Socket();
          socket.setTimeout(5000);
          socket.once("connect", () => {
            const latencyMs = Date.now() - start;
            socket.destroy();
            resolve({
              success: true,
              latencyMs,
              message: `Conexión TCP exitosa hacia ${host}:${port} (${latencyMs}ms)`,
            });
          });
          socket.once("timeout", () => {
            socket.destroy();
            resolve({
              success: false,
              latencyMs: Date.now() - start,
              message: `Timeout al conectar hacia ${host}:${port}`,
            });
          });
          socket.once("error", (err) => {
            socket.destroy();
            resolve({
              success: false,
              latencyMs: Date.now() - start,
              message: `No se pudo alcanzar ${host}:${port} (${err.message})`,
            });
          });
          socket.connect(port, host);
        });
        res.json({ success: tcpResult.success, data: tcpResult });
      }
      const payload = { ...req.body };
      // Fallback: si no se enviaron host ni ip pero sí routerId, hidratamos automáticamente desde MikroTik
      if (!payload.host && !payload.ip && payload.routerId) {
        try {
          const rData = await proxyMikrotik(`/v1/network/routers/${payload.routerId}`);
          const r = rData.router || rData.data;
          if (r) {
            payload.host = r.host;
            payload.ip = r.host;
            payload.port = payload.port || r.port;
            payload.username = payload.username || r.username;
          }
        } catch {
          // Ignorar si falla lookup
        }
      }
      const result = await proxyMikrotik("/v1/network/test-connection", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      res.json({ success: result.success, data: result });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/settings/network/import
  // Permite subir un archivo o payload JSON directamente desde el Frontend con la topología completa
  router.post(
    "/api/admin/settings/network/import",
    uploadTopology.any(),
    async (req, res, next) => {
      try {
        const agent = await requireNetworkAccess(req);

        let payload: any = req.body;
        const uploadedFile =
          req.file ?? (Array.isArray(req.files) && req.files.length > 0 ? req.files[0] : undefined);

        if (uploadedFile?.buffer) {
          try {
            payload = JSON.parse(uploadedFile.buffer.toString("utf-8"));
          } catch {
            throw validationError("El archivo adjunto no contiene un JSON válido");
          }
        } else if (typeof req.body?.json === "string") {
          try {
            payload = JSON.parse(req.body.json);
          } catch {
            throw validationError("El campo 'json' no contiene un JSON válido");
          }
        } else if (typeof req.body === "string") {
          try {
            payload = JSON.parse(req.body);
          } catch {
            throw validationError("El cuerpo de la petición no contiene un JSON válido");
          }
        }

        const extractRoutersArray = (source: any): any[] | null => {
          if (!source) return null;
          if (Array.isArray(source)) return source;
          if (Array.isArray(source.routers)) return source.routers;
          if (Array.isArray(source.data?.routers)) return source.data.routers;
          if (Array.isArray(source.data)) return source.data;
          if (Array.isArray(source.topology?.routers)) return source.topology.routers;
          if (typeof source === "object" && (source.name || source.sector) && (source.ip || source.host || source.address || source.mikrotik)) {
            return [source];
          }
          const candidateMap =
            source.routers && typeof source.routers === "object" && !Array.isArray(source.routers)
              ? source.routers
              : source.topology && typeof source.topology === "object" && !Array.isArray(source.topology)
                ? source.topology
                : typeof source === "object" && !Array.isArray(source)
                  ? source
                  : null;
          if (candidateMap) {
            const entries = Object.entries(candidateMap).filter(
              ([k, v]) =>
                k !== "exportedAt" &&
                k !== "version" &&
                v &&
                typeof v === "object" &&
                !Array.isArray(v) &&
                ((v as any).ip || (v as any).host || (v as any).address || (v as any).mikrotik || (v as any).olts),
            );
            if (entries.length > 0) {
              return entries.map(([key, val]) => ({
                name: (val as any).name || key,
                sector: (val as any).sector || key,
                ...(val as Record<string, any>),
              }));
            }
          }
          return null;
        };

        const rawRouters = extractRoutersArray(payload);

        if (!rawRouters || rawRouters.length === 0) {
          throw validationError("El cuerpo o archivo debe contener un arreglo de 'routers'");
        }

        // 1. Consultar routers existentes (microservicio si está activo + respaldo local en BD)
        const localRouters = [...(await settingsService.getNetworkTopology())];
        const listData = await proxyMikrotik("/v1/network/routers").catch(() => ({ routers: [] }));
        const remoteRouters = (
          Array.isArray(listData) ? listData : listData.routers || listData.data || []
        ) as Array<{
          id: string;
          name?: string;
          sector?: string;
          olts?: Array<{ id: string; name?: string }>;
        }>;

        const results: Array<{
          routerName: string;
          routerId: string;
          status: "created" | "existing";
          olts: Array<{ oltName: string; status: "created" | "existing" | "error" }>;
        }> = [];

        for (const rawItem of rawRouters) {
          if (!rawItem || typeof rawItem !== "object") continue;
          const mktSub = rawItem.mikrotik && typeof rawItem.mikrotik === "object" ? rawItem.mikrotik : {};
          const item = { ...mktSub, ...rawItem };
          const routerName = String(item.name || item.sector || item.displayName || "").trim();
          const routerHost = String(
            item.host || item.ip || item.address || mktSub.host || mktSub.ip || "",
          ).trim();
          if (!routerName || !routerHost) continue;

          const existingRemote = remoteRouters.find(
            (r) =>
              String(r.name || "").toLowerCase() === routerName.toLowerCase() ||
              (item.sector &&
                r.sector &&
                String(r.sector).toLowerCase() === String(item.sector).toLowerCase()) ||
              (item.displayName &&
                r.name &&
                String(r.name).toLowerCase() === String(item.displayName).toLowerCase()),
          );

          const existingLocalIdx = localRouters.findIndex(
            (r) =>
              String(r.name || "").toLowerCase() === routerName.toLowerCase() ||
              (item.sector &&
                r.sector &&
                String(r.sector).toLowerCase() === String(item.sector).toLowerCase()),
          );
          const existingLocal = existingLocalIdx >= 0 ? localRouters[existingLocalIdx] : undefined;

          let routerId = existingRemote?.id || existingLocal?.id || item.id || "";
          let status: "created" | "existing" = existingRemote || existingLocal ? "existing" : "created";

          if (!existingRemote) {
            try {
              const created = await proxyMikrotik("/v1/network/routers", {
                method: "POST",
                body: JSON.stringify({
                  name: routerName,
                  displayName: item.displayName || item.sector || routerName,
                  sector: item.sector || item.displayName || routerName,
                  host: routerHost,
                  ip: routerHost,
                  port: Number(item.port ?? mktSub.port ?? 8728),
                  username: item.username || item.user || mktSub.username || mktSub.user || "admin",
                  password: item.password || item.pass || mktSub.password || mktSub.pass || "",
                  description: item.description || "",
                }),
              });
              routerId =
                created.router?.id || created.data?.id || created.id || routerId || randomUUID();
              status = "created";
            } catch (err) {
              logger.warn(
                { err, routerName },
                "Microservicio de red no disponible o rechazó creación al importar router; guardando en BD local",
              );
              if (!routerId) {
                routerId = randomUUID();
              }
            }
          }

          const oltResults: Array<{ oltName: string; status: "created" | "existing" | "error" }> = [];
          const normalizedOlts: Record<string, any>[] = Array.isArray(existingLocal?.olts)
            ? [...existingLocal.olts]
            : [];

          const rawOltsList: any[] = Array.isArray(item.olts)
            ? item.olts
            : item.olts && typeof item.olts === "object"
              ? Object.entries(item.olts).map(([k, v]) =>
                  v && typeof v === "object" ? { name: (v as any).name || k, ...(v as object) } : null,
                ).filter(Boolean)
              : [];

          if (routerId && rawOltsList.length > 0) {
            const currentRemoteOlts = Array.isArray(existingRemote?.olts) ? existingRemote.olts : [];
            for (const olt of rawOltsList) {
              if (!olt || typeof olt !== "object") continue;
              const oltName = String(olt.name || olt.id || "").trim();
              const oltIp = String(olt.ip || olt.host || olt.address || "").trim();
              if (!oltName || !oltIp) continue;

              const oltExistsRemote = currentRemoteOlts.some(
                (o) => String(o.name || "").toLowerCase() === oltName.toLowerCase(),
              );
              const existingOltLocalIdx = normalizedOlts.findIndex(
                (o) => String(o.name || "").toLowerCase() === oltName.toLowerCase(),
              );
              const existingOltLocal =
                existingOltLocalIdx >= 0 ? normalizedOlts[existingOltLocalIdx] : undefined;

              let oltId = existingOltLocal?.id || olt.id || randomUUID();

              if (oltExistsRemote) {
                oltResults.push({ oltName, status: "existing" });
              } else {
                try {
                  const createdOlt = await proxyMikrotik(`/v1/network/routers/${routerId}/olts`, {
                    method: "POST",
                    body: JSON.stringify({
                      name: oltName,
                      displayName: olt.displayName || `OLT ${oltName}`,
                      ip: oltIp,
                      brand: String(olt.brand || "huawei").toLowerCase(),
                      model: olt.model || "",
                      port: Number(olt.port ?? 23),
                      username: olt.username || olt.user || "admin",
                      password: olt.password || olt.pass || "",
                      slot: olt.slot,
                      ponPorts: Number(olt.ponPorts ?? 8),
                    }),
                  });
                  oltId = createdOlt.olt?.id || createdOlt.data?.id || createdOlt.id || oltId;
                  oltResults.push({ oltName, status: "created" });
                } catch {
                  // Aunque el microservicio esté apagado o devuelva conflicto, la OLT queda importada en la BD local
                  oltResults.push({
                    oltName,
                    status: existingOltLocal ? "existing" : "created",
                  });
                }
              }

              const oltRecord: Record<string, any> = {
                ...(existingOltLocal || {}),
                id: oltId,
                name: oltName,
                displayName: olt.displayName || `OLT ${oltName}`,
                ip: oltIp,
                host: oltIp,
                brand: String(olt.brand || "huawei").toLowerCase(),
                model: olt.model ?? existingOltLocal?.model ?? "",
                port: Number(olt.port ?? existingOltLocal?.port ?? 23),
                username: olt.username || olt.user || existingOltLocal?.username || "admin",
                user: olt.user || olt.username || existingOltLocal?.user || "admin",
                password: olt.password ?? olt.pass ?? existingOltLocal?.password ?? "",
                slot: olt.slot ?? existingOltLocal?.slot,
                ponPorts: Number(olt.ponPorts ?? existingOltLocal?.ponPorts ?? 8),
              };

              if (existingOltLocalIdx >= 0) {
                normalizedOlts[existingOltLocalIdx] = oltRecord;
              } else {
                normalizedOlts.push(oltRecord);
              }
            }
          }

          const routerRecord: Record<string, any> = {
            ...(existingLocal || {}),
            id: routerId,
            name: routerName,
            displayName: item.displayName || item.sector || routerName,
            sector: item.sector || existingLocal?.sector || item.displayName || routerName,
            host: routerHost,
            ip: routerHost,
            port: Number(item.port ?? mktSub.port ?? existingLocal?.port ?? 8728),
            username:
              item.username || item.user || mktSub.username || mktSub.user || existingLocal?.username || "admin",
            user:
              item.user || item.username || mktSub.user || mktSub.username || existingLocal?.user || "admin",
            password:
              item.password ?? item.pass ?? mktSub.password ?? mktSub.pass ?? existingLocal?.password ?? "",
            description: item.description ?? existingLocal?.description ?? "",
            active: item.active ?? true,
            olts: normalizedOlts,
          };

          if (existingLocalIdx >= 0) {
            localRouters[existingLocalIdx] = routerRecord;
          } else {
            localRouters.push(routerRecord);
          }

          results.push({
            routerName,
            routerId,
            status,
            olts: oltResults,
          });
        }

        await settingsService.saveNetworkTopology(localRouters, agent.id);

        res.status(200).json({
          success: true,
          message: `Importación completada: ${results.length} routers procesados`,
          data: results,
          routers: localRouters,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/admin/settings/network/export
  // Exporta la topología actual completa con contraseñas descifradas para administradores autorizados
  router.get("/api/admin/settings/network/export", async (req, res, next) => {
    try {
      await requireNetworkAccess(req);
      const localRouters = await settingsService.getNetworkTopology();
      let routers: any[] = localRouters;
      try {
        const data = await proxyMikrotik("/v1/network/routers");
        const remote = (data.routers || data.data || []) as any[];
        if (remote.length > 0) {
          routers = remote;
        }
      } catch {
        // Fallback a topología local persistida en BD
      }

      // Resolver contraseñas descifradas para que el archivo sea un backup completo e importable
      const fullRouters = await Promise.all(
        routers.map(async (router) => {
          const localMatch = localRouters.find(
            (l) =>
              l.id === router.id ||
              String(l.name || "").toLowerCase() === String(router.name || "").toLowerCase(),
          );
          let routerPassword = router.password || localMatch?.password || "";
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

          const rawOlts =
            Array.isArray(router.olts) && router.olts.length > 0
              ? router.olts
              : Array.isArray(localMatch?.olts)
                ? localMatch.olts
                : [];

          const olts = await Promise.all(
            rawOlts.map(async (olt: any) => {
              const localOltMatch = (Array.isArray(localMatch?.olts) ? localMatch.olts : []).find(
                (lo: any) =>
                  lo.id === olt.id ||
                  String(lo.name || "").toLowerCase() === String(olt.name || "").toLowerCase(),
              );
              let oltPassword = olt.password || localOltMatch?.password || "";
              if (router.id && olt.id) {
                try {
                  const oltPassData = await proxyMikrotik(
                    `/v1/network/routers/${router.id}/olts/${olt.id}/password`,
                  );
                  if (oltPassData && oltPassData.password) {
                    oltPassword = oltPassData.password;
                  }
                } catch {
                  // Mantener valor previo si falla
                }
              }
              return {
                ...localOltMatch,
                ...olt,
                password: oltPassword,
              };
            }),
          );

          return {
            ...localMatch,
            ...router,
            password: routerPassword,
            olts,
          };
        }),
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
