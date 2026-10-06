import { describe, it, expect, beforeEach, vi } from "vitest";
import { SystemSettingsService } from "../../src/core/modules/settings/application/services/system-settings.service";
import type { SystemSettingsRepositoryPort } from "../../src/core/modules/settings/application/ports/system-settings.repository.port";
import {
  maskSecret,
  mergeSecret,
  isMaskedValue,
} from "../../src/core/modules/settings/domain/system-settings.entity";
import type { Env } from "../../src/shared/config/env";
import type { Logger } from "../../src/shared/logging/logger";
import { DynamicWhatsAppSender } from "../../src/core/modules/conversations/infrastructure/dynamic-whatsapp-sender";
import { DynamicAiProvider } from "../../src/core/modules/ai/infrastructure/dynamic/dynamic-ai-provider";
import type { WhatsAppSenderPort } from "../../src/core/modules/conversations/application/ports/whatsapp-sender.port";
import type { AIProviderPort } from "../../src/core/modules/ai/application/ports/ai-provider.port";

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

describe("SystemSettings - Seguridad y Configuración Dinámica", () => {
  let repo: SystemSettingsRepositoryFake;
  let service: SystemSettingsService;

  beforeEach(() => {
    repo = new SystemSettingsRepositoryFake();
    service = new SystemSettingsService(repo, fakeEnv, silentLogger);
  });

  describe("Enmascaramiento de Credenciales y Secretos", () => {
    it("enmascara mostrando solo los últimos 4 caracteres para valores largos", () => {
      const masked = maskSecret("EAAG_real_super_secret_token_abcd");
      expect(masked).toBe("••••••••••••abcd");
      expect(masked).not.toContain("EAAG_real_super_secret");
    });

    it("enmascara completamente valores cortos (<= 4 caracteres)", () => {
      expect(maskSecret("1234")).toBe("••••••••");
      expect(maskSecret("ab")).toBe("••••••••");
    });

    it("retorna string vacío si el secreto no existe o es vacío", () => {
      expect(maskSecret("")).toBe("");
      expect(maskSecret(null)).toBe("");
      expect(maskSecret(undefined)).toBe("");
    });

    it("detecta correctamente si un valor está enmascarado", () => {
      expect(isMaskedValue("••••••••••••abcd")).toBe(true);
      expect(isMaskedValue("********abcd")).toBe(true);
      expect(isMaskedValue("EAAG_real_super_secret_token_abcd")).toBe(false);
      expect(isMaskedValue("")).toBe(false);
      expect(isMaskedValue(null)).toBe(false);
    });

    it("preserva el secreto existente si el frontend envía el valor enmascarado o vacío", () => {
      const existing = "super_secret_real_key_1234";

      // El usuario no modificó el campo y envió la versión enmascarada
      const preservedMasked = mergeSecret("••••••••••••1234", existing);
      expect(preservedMasked).toBe(existing);

      // El usuario envió vacío sin intención de borrar
      const preservedEmpty = mergeSecret("", existing);
      expect(preservedEmpty).toBe(existing);

      // El usuario escribió una clave nueva real
      const updated = mergeSecret("new_brand_secret_key_9999", existing);
      expect(updated).toBe("new_brand_secret_key_9999");
    });
  });

  describe("Fallback a Variables de Entorno (.env)", () => {
    it("retorna los valores del .env cuando la base de datos no tiene configuraciones guardadas", async () => {
      const channels = await service.getChannelSettings();
      expect(channels.provider).toBe("meta");
      expect(channels.phoneNumberId).toBe("10987654321");
      expect(channels.accessToken).toBe("EAAG_real_super_secret_token_abcd");

      const ai = await service.getAiSettings();
      expect(ai.provider).toBe("gemini");
      expect(ai.geminiApiKey).toBe("AIzaSy_gemini_secret_key_8888");
      expect(ai.geminiModel).toBe("gemini-2.5-flash");
      expect(ai.ollamaModel).toBe("qwen3.5:4b");
    });

    it("retorna secretos enmascarados al consultar métodos seguros", async () => {
      const maskedChannels = await service.getMaskedChannelSettings();
      expect(maskedChannels.accessToken).toBe("••••••••••••abcd");
      expect(maskedChannels.appSecret).toBe("••••••••••••1234");
      expect(maskedChannels.zernioApiKey).toBe("••••••••••••9999");
      expect(maskedChannels.phoneNumberId).toBe("10987654321"); // No es secreto, no se enmascara

      const maskedAi = await service.getMaskedAiSettings();
      expect(maskedAi.geminiApiKey).toBe("••••••••••••8888");
      expect(maskedAi.geminiModel).toBe("gemini-2.5-flash"); // Modelo visible
    });
  });

  describe("Actualización Dinámica de Canales", () => {
    it("actualiza el número de WhatsApp y preserva los secretos cuando se reciben enmascarados", async () => {
      const updated = await service.updateChannelSettings({
        phoneNumberId: "10429998888",
        accessToken: "••••••••••••abcd", // Viene enmascarado desde el front
      }, "admin-1");

      expect(updated.phoneNumberId).toBe("10429998888");
      expect(updated.accessToken).toBe("••••••••••••abcd"); // Respuesta enmascarada

      // Verificamos el valor real sin enmascarar en la capa interna
      const raw = await service.getChannelSettings();
      expect(raw.phoneNumberId).toBe("10429998888");
      expect(raw.accessToken).toBe("EAAG_real_super_secret_token_abcd"); // Preservado intacto!
    });

    it("actualiza el secreto cuando el usuario ingresa un nuevo token en texto plano", async () => {
      await service.updateChannelSettings({
        accessToken: "EAAG_nuevo_token_real_xyz9",
      });

      const raw = await service.getChannelSettings();
      expect(raw.accessToken).toBe("EAAG_nuevo_token_real_xyz9");

      const masked = await service.getMaskedChannelSettings();
      expect(masked.accessToken).toBe("••••••••••••xyz9");
    });
  });

  describe("Actualización Dinámica de Modelos de IA", () => {
    it("permite cambiar el modelo de Gemini y Ollama sin redesplegar", async () => {
      const updated = await service.updateAiSettings({
        geminiModel: "gemini-1.5-pro",
        ollamaModel: "qwen2.5:7b",
      }, "admin-1");

      expect(updated.geminiModel).toBe("gemini-1.5-pro");
      expect(updated.ollamaModel).toBe("qwen2.5:7b");

      const raw = await service.getAiSettings();
      expect(raw.geminiModel).toBe("gemini-1.5-pro");
      expect(raw.ollamaModel).toBe("qwen2.5:7b");
      expect(raw.geminiApiKey).toBe("AIzaSy_gemini_secret_key_8888"); // Api key no fue modificada
    });

    it("permite conmutar el proveedor de IA entre gemini y ollama", async () => {
      await service.updateAiSettings({
        provider: "ollama",
      });

      const raw = await service.getAiSettings();
      expect(raw.provider).toBe("ollama");
    });
  });

  describe("Setup Status para Onboarding / Frontend", () => {
    it("calcula correctamente el estado del setup", async () => {
      const status = await service.getSetupStatus();
      expect(status.isChannelConfigured).toBe(true);
      expect(status.isAiConfigured).toBe(true);
      expect(status.activeChannelProvider).toBe("meta");
      expect(status.activeAiProvider).toBe("gemini");
    });
  });

  describe("Dynamic Adapters Delegation", () => {
    it("DynamicWhatsAppSender delega a Meta o Zernio según la configuración activa", async () => {
      const metaSender: WhatsAppSenderPort = {
        sendText: vi.fn().mockResolvedValue({ externalId: "meta-msg-1" }),
        sendTemplate: vi.fn().mockResolvedValue({ externalId: "meta-tpl-1" }),
      };
      const zernioSender: WhatsAppSenderPort = {
        sendText: vi.fn().mockResolvedValue({ externalId: "zernio-msg-1" }),
        sendTemplate: vi.fn().mockResolvedValue({ externalId: "zernio-tpl-1" }),
      };

      const dynamicSender = new DynamicWhatsAppSender(service, metaSender, zernioSender);

      // Inicialmente en fakeEnv es "meta"
      const resMeta = await dynamicSender.sendText("5491122334455", "Hola");
      expect(resMeta.externalId).toBe("meta-msg-1");
      expect(metaSender.sendText).toHaveBeenCalledTimes(1);
      expect(zernioSender.sendText).not.toHaveBeenCalled();

      // Cambiamos el proveedor en tiempo de ejecución a "zernio"
      await service.updateChannelSettings({ provider: "zernio" });

      const resZernio = await dynamicSender.sendText("5491122334455", "Hola Zernio");
      expect(resZernio.externalId).toBe("zernio-msg-1");
      expect(zernioSender.sendText).toHaveBeenCalledTimes(1);
    });

    it("DynamicAiProvider delega a Gemini u Ollama según la configuración activa", async () => {
      const geminiProvider: AIProviderPort = {
        interpretMessage: vi.fn().mockResolvedValue({ type: "NEW_INTENT", intent: "support.internet", entities: {}, confidence: 0.95 }),
        composeReply: vi.fn().mockResolvedValue("Respuesta Gemini"),
        transcribeAudio: vi.fn(),
        extractReceiptData: vi.fn(),
        analyzeAgentConversation: vi.fn(),
        refineTextTone: vi.fn(),
      };
      const ollamaProvider: AIProviderPort = {
        interpretMessage: vi.fn().mockResolvedValue({ type: "NEW_INTENT", intent: "billing.balance", entities: {}, confidence: 0.9 }),
        composeReply: vi.fn().mockResolvedValue("Respuesta Ollama"),
        transcribeAudio: vi.fn(),
        extractReceiptData: vi.fn(),
        analyzeAgentConversation: vi.fn(),
        refineTextTone: vi.fn(),
      };

      const dynamicAi = new DynamicAiProvider(service, geminiProvider, ollamaProvider);

      // Inicialmente en fakeEnv es "gemini"
      const replyGemini = await dynamicAi.composeReply({
        caseId: "c-1",
        workflowType: "SUPPORT_INTERNET",
        stepOutcome: { action: "PING", status: "COMPLETED" },
      });
      expect(replyGemini).toBe("Respuesta Gemini");
      expect(geminiProvider.composeReply).toHaveBeenCalledTimes(1);
      expect(ollamaProvider.composeReply).not.toHaveBeenCalled();

      // Conmutamos a Ollama dinámicamente
      await service.updateAiSettings({ provider: "ollama" });

      const replyOllama = await dynamicAi.composeReply({
        caseId: "c-1",
        workflowType: "SUPPORT_INTERNET",
        stepOutcome: { action: "PING", status: "COMPLETED" },
      });
      expect(replyOllama).toBe("Respuesta Ollama");
      expect(ollamaProvider.composeReply).toHaveBeenCalledTimes(1);
    });

    it("permite configurar y recuperar el debounce del buffer de mensajes", async () => {
      // Valor por defecto en fakeEnv es 1000
      const initialDelay = await service.getMessageDebounceMs();
      expect(initialDelay).toBe(1000);

      // Actualizamos a 8500 ms
      const updated = await service.updateChannelSettings({ messageDebounceMs: 8500 });
      expect(updated.messageDebounceMs).toBe(8500);

      const dynamicDelay = await service.getMessageDebounceMs();
      expect(dynamicDelay).toBe(8500);
    });
  });
});
