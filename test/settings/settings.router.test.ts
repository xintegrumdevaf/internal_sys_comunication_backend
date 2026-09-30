import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach } from "vitest";
import { createSettingsRouter } from "../../src/core/modules/settings/presentation/settings.router";
import { SystemSettingsService } from "../../src/core/modules/settings/application/services/system-settings.service";
import type { SystemSettingsRepositoryPort } from "../../src/core/modules/settings/application/ports/system-settings.repository.port";
import type { Env } from "../../src/shared/config/env";
import type { Logger } from "../../src/shared/logging/logger";

import { createErrorHandler } from "../../src/shared/http/middlewares/error-handler.middleware";

class SystemSettingsRepositoryFake implements SystemSettingsRepositoryPort {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    const val = this.store.get(key);
    return val !== undefined ? (JSON.parse(JSON.stringify(val)) as T) : null;
  }

  async set<T>(key: string, value: T, _description?: string, _updatedBy?: string): Promise<void> {
    this.store.set(key, JSON.parse(JSON.stringify(value)));
  }

  async listAll(): Promise<Record<string, unknown>> {
    const res: Record<string, unknown> = {};
    for (const [key, value] of this.store.entries()) {
      res[key] = value;
    }
    return res;
  }
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const fakeEnv: Env = {
  NODE_ENV: "test",
  PORT: 3000,
  APP_PUBLIC_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  SESSION_TTL_SECONDS: 86400,
  API_INTERNAL_KEY: "internal-secret",
  CORS_ALLOWED_ORIGINS: "*",
  WHATSAPP_PROVIDER: "meta",
  WHATSAPP_PHONE_NUMBER_ID: "10987654321",
  META_WABA_ID: "waba-default-123",
  META_ACCESS_TOKEN: "EAAG_real_super_secret_token_abcd",
  WHATSAPP_ACCESS_TOKEN: "EAAG_real_super_secret_token_abcd",
  WHATSAPP_APP_SECRET: "app_secret_1234",
  WHATSAPP_VERIFY_TOKEN: "verify_token_5678",
  ZERNIO_API_KEY: "zernio_secret_key_9999",
  ZERNIO_ACCOUNT_ID: "zernio_acc_111",
  ZERNIO_WEBHOOK_SECRET: "zernio_wh_sec_222",
  ZERNIO_BASE_URL: "https://zernio.com/api/v1",
  AI_PROVIDER: "gemini",
  GEMINI_API_KEY: "AIzaSy_gemini_secret_key_8888",
  GEMINI_MODEL: "gemini-2.5-flash",
  GEMINI_EMBEDDING_MODEL: "gemini-embedding-2",
  GEMINI_EMBEDDING_DIMENSION: 768,
  OLLAMA_BASE_URL: "http://localhost:11434",
  OLLAMA_MODEL: "qwen3.5:4b",
  OLLAMA_EMBEDDING_MODEL: "qwen3-embedding:4b",
  OLLAMA_EMBEDDING_DIMENSION: 2560,
  AI_CALL_TIMEOUT_MS: 45000,
  AI_QUALITY_TIMEOUT_MS: 600000,
  QUALITY_ANALYSIS_CHUNK_SIZE: 40,
  MESSAGE_DEBOUNCE_MS: 1000,
  AUTO_ASSIGN_MAX_ACTIVE_CASES_PER_AGENT: 5,
  N8N_CALL_TIMEOUT_MS: 5000,
  N8N_CALL_MAX_RETRIES: 1,
  MIKROTIK_SERVICE_URL: "http://localhost:8080",
  MIKROTIK_DIAGNOSTIC_TIMEOUT_MS: 5000,
};

describe("Endpoints de Configuración del Sistema (Settings Router)", () => {
  let app: express.Express;
  let service: SystemSettingsService;
  let currentRole: "admin" | "agent" | null = "admin";

  beforeEach(() => {
    const repo = new SystemSettingsRepositoryFake();
    service = new SystemSettingsService(repo, fakeEnv, silentLogger);

    app = express();
    app.use(express.json());

    // Mock middleware de autenticación
    app.use((req, _res, next) => {
      if (currentRole) {
        (req as unknown as { agent: { id: string; role: string; name: string; active: boolean } }).agent = {
          id: "agent-123",
          role: currentRole,
          name: "Test User",
          active: true,
        };
      }
      next();
    });

    app.use(createSettingsRouter({ settingsService: service, logger: silentLogger }));
    app.use(createErrorHandler(silentLogger));
  });

  describe("Seguridad y Control de Acceso (RBAC)", () => {
    it("permite a un admin consultar las configuraciones enmascaradas", async () => {
      currentRole = "admin";
      const res = await request(app).get("/api/admin/settings");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.channels.accessToken).toBe("••••••••••••abcd");
      expect(res.body.data.channels.appSecret).toBe("••••••••••••1234");
      expect(res.body.data.ai.geminiApiKey).toBe("••••••••••••8888");
      // Nunca expone claves en texto plano
      expect(JSON.stringify(res.body)).not.toContain("EAAG_real_super_secret");
      expect(JSON.stringify(res.body)).not.toContain("AIzaSy_gemini_secret_key");
    });

    it("rechaza con 403 a un agente no administrador", async () => {
      currentRole = "agent";
      const res = await request(app).get("/api/admin/settings");
      expect(res.status).toBe(403);
    });

    it("rechaza con 403 si no hay sesión autenticada", async () => {
      currentRole = null;
      const res = await request(app).get("/api/admin/settings");
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/admin/settings/channels", () => {
    it("permite a un admin actualizar número de WhatsApp y preserva tokens enmascarados", async () => {
      currentRole = "admin";
      const res = await request(app)
        .put("/api/admin/settings/channels")
        .send({
          phoneNumberId: "10425556666",
          accessToken: "••••••••••••abcd", // Sin tocar el token en el front
        });

      expect(res.status).toBe(200);
      expect(res.body.data.phoneNumberId).toBe("10425556666");
      expect(res.body.data.accessToken).toBe("••••••••••••abcd");

      // Verificamos que el valor real se conserva
      const raw = await service.getChannelSettings();
      expect(raw.phoneNumberId).toBe("10425556666");
      expect(raw.accessToken).toBe("EAAG_real_super_secret_token_abcd");
    });
  });

  describe("PUT /api/admin/settings/ai", () => {
    it("permite a un admin cambiar el modelo de IA dinámicamente", async () => {
      currentRole = "admin";
      const res = await request(app)
        .put("/api/admin/settings/ai")
        .send({
          geminiModel: "gemini-1.5-pro",
          ollamaModel: "qwen2.5:7b",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.geminiModel).toBe("gemini-1.5-pro");
      expect(res.body.data.ollamaModel).toBe("qwen2.5:7b");

      const raw = await service.getAiSettings();
      expect(raw.geminiModel).toBe("gemini-1.5-pro");
      expect(raw.ollamaModel).toBe("qwen2.5:7b");
    });
  });

  describe("GET /api/admin/settings/setup-status", () => {
    it("retorna el estado de configuración para onboarding sin exponer credenciales", async () => {
      currentRole = "agent"; // Cualquier usuario autenticado puede consultar el estado del wizard
      const res = await request(app).get("/api/admin/settings/setup-status");

      expect(res.status).toBe(200);
      expect(res.body.data.isChannelConfigured).toBe(true);
      expect(res.body.data.isAiConfigured).toBe(true);
      expect(res.body.data.activeChannelProvider).toBe("meta");
      expect(res.body.data.activeAiProvider).toBe("gemini");
      // Cero secretos en la respuesta
      expect(res.body.data.accessToken).toBeUndefined();
      expect(res.body.data.geminiApiKey).toBeUndefined();
    });
  });
});
