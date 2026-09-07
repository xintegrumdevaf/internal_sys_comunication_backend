import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZernioSenderHttp } from "../../src/core/modules/conversations/infrastructure/zernio/zernio-sender.http";
import type { Env } from "../../src/shared/config/env";
import type { Logger } from "../../src/shared/logging/logger";

describe("ZernioSenderHttp", () => {
  const fakeEnv: Env = {
    NODE_ENV: "test",
    PORT: 3000,
    APP_PUBLIC_URL: "http://localhost:3000",
    DATABASE_URL: "postgres://localhost/test",
    REDIS_URL: "redis://localhost:6379",
    API_INTERNAL_KEY: "test-key",
    CORS_ALLOWED_ORIGINS: "",
    SESSION_TTL_SECONDS: 3600,
    WHATSAPP_APP_SECRET: "",
    WHATSAPP_VERIFY_TOKEN: "",
    WHATSAPP_PHONE_NUMBER_ID: "",
    WHATSAPP_ACCESS_TOKEN: "",
    META_WABA_ID: "",
    META_ACCESS_TOKEN: "",
    WHATSAPP_PROVIDER: "zernio",
    ZERNIO_API_KEY: "test-zernio-key",
    ZERNIO_ACCOUNT_ID: "6a9ec34a77555aae01ec0fde",
    ZERNIO_WEBHOOK_SECRET: "",
    ZERNIO_BASE_URL: "https://zernio.com/api/v1",
    AI_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_MODEL: "qwen",
    OLLAMA_EMBEDDING_MODEL: "qwen-emb",
    OLLAMA_EMBEDDING_DIMENSION: 2560,
    GEMINI_API_KEY: "",
    GEMINI_MODEL: "gemini",
    GEMINI_EMBEDDING_MODEL: "gemini-emb",
    GEMINI_EMBEDDING_DIMENSION: 768,
    AI_CALL_TIMEOUT_MS: 5000,
    AI_QUALITY_TIMEOUT_MS: 5000,
    QUALITY_ANALYSIS_CHUNK_SIZE: 40,
    MESSAGE_DEBOUNCE_MS: 1000,
    AUTO_ASSIGN_MAX_ACTIVE_CASES_PER_AGENT: 5,
    N8N_CALL_TIMEOUT_MS: 5000,
    N8N_CALL_MAX_RETRIES: 1,
    MIKROTIK_SERVICE_URL: "http://localhost:3001/api",
    MIKROTIK_DIAGNOSTIC_TIMEOUT_MS: 5000,
  };

  const fakeLogger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("envía mensaje a conversación existente si ya está registrada", async () => {
    const sender = new ZernioSenderHttp(fakeEnv, fakeLogger);
    sender.registerConversation("593993546974", "conv_existing_123");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "msg_sent_1",
        platformMessageId: "wamid.SENT1",
      }),
    });
    global.fetch = mockFetch;

    const result = await sender.sendText("+593 99 354 6974", "Hola, tu ticket ha sido resuelto");

    expect(result.externalId).toBe("wamid.SENT1");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://zernio.com/api/v1/inbox/conversations/conv_existing_123/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          accountId: "6a9ec34a77555aae01ec0fde",
          message: "Hola, tu ticket ha sido resuelto",
        }),
      }),
    );
  });

  it("crea/inicia conversación si no existía previamente en cache", async () => {
    const sender = new ZernioSenderHttp(fakeEnv, fakeLogger);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/inbox/conversations?platform=whatsapp")) {
        return {
          ok: true,
          json: async () => ({ data: [] }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          id: "msg_new_1",
          platformMessageId: "wamid.NEW1",
        }),
      };
    });
    global.fetch = mockFetch;

    const result = await sender.sendText("593987654321", "Primer mensaje");
    expect(result.externalId).toBe("wamid.NEW1");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://zernio.com/api/v1/inbox/conversations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          accountId: "6a9ec34a77555aae01ec0fde",
          participantId: "593987654321",
          message: "Primer mensaje",
        }),
      }),
    );
  });

  it("envía plantilla con parámetros", async () => {
    const sender = new ZernioSenderHttp(fakeEnv, fakeLogger);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "tpl_sent_1",
        platformMessageId: "wamid.TPL1",
      }),
    });
    global.fetch = mockFetch;

    const result = await sender.sendTemplate(
      "593993546974",
      "aviso_cobro",
      "es",
      ["Juan", "$25.00"],
    );

    expect(result.externalId).toBe("wamid.TPL1");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://zernio.com/api/v1/inbox/conversations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          accountId: "6a9ec34a77555aae01ec0fde",
          participantId: "593993546974",
          templateName: "aviso_cobro",
          templateLanguage: "es",
          templateParams: ["Juan", "$25.00"],
        }),
      }),
    );
  });
});
