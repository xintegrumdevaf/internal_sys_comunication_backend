import { Router } from "express";
import { requireRole, requireAuth } from "../../../../shared/http/require-auth";
import type { SystemSettingsService } from "../application/services/system-settings.service";
import type { Logger } from "../../../../shared/logging/logger";

export interface SettingsRouterDeps {
  settingsService: SystemSettingsService;
  logger: Logger;
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const router = Router();
  const { settingsService, logger } = deps;

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

  return router;
}
