import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZernioTemplatesGatewayHttp } from "../../src/core/modules/message-templates/infrastructure/zernio/zernio-templates-gateway.http";
import type { Env } from "../../src/shared/config/env";
import type { Logger } from "../../src/shared/logging/logger";

describe("ZernioTemplatesGatewayHttp", () => {
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
    WHATSAPP_ACCESS_TOKEN: "test-token",
    META_WABA_ID: "123456789",
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

  it("envía plantilla a Zernio correctamente y retorna ID y estado", async () => {
    const gateway = new ZernioTemplatesGatewayHttp(fakeEnv, fakeLogger);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        template: {
          id: "tpl_meta_9876",
          name: "aviso_pago",
          status: "PENDING",
        },
      }),
    });
    global.fetch = mockFetch;

    const result = await gateway.submitTemplate({
      name: "aviso_pago",
      category: "UTILITY",
      language: "es",
      headerType: "NONE",
      bodyText: "Hola {{1}}, tu factura de {{2}} está lista.",
    });

    expect(result.metaTemplateId).toBe("tpl_meta_9876");
    expect(result.status).toBe("PENDING");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://zernio.com/api/v1/whatsapp/templates",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-zernio-key",
        }),
      }),
    );
    const sentBody = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string);
    expect(sentBody.components[0].type).toBe("body");
  });

  it("envía plantilla con encabezado de tipo IMAGE incluyendo example.header_handle", async () => {
    const gateway = new ZernioTemplatesGatewayHttp(fakeEnv, fakeLogger);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        template: {
          id: "tpl_meta_img_123",
          name: "oferta_imagen",
          status: "PENDING",
        },
      }),
    });
    global.fetch = mockFetch;

    const result = await gateway.submitTemplate({
      name: "oferta_imagen",
      category: "MARKETING",
      language: "es",
      headerType: "IMAGE",
      headerContent: "https://example.com/promocion.png",
      bodyText: "Hola {{1}}, mira nuestra promoción.",
    });

    expect(result.metaTemplateId).toBe("tpl_meta_img_123");
    const sentBody = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string);
    expect(sentBody.components[0].type).toBe("header");
    expect(sentBody.components[0].format).toBe("image");
    expect(sentBody.components[0].example).toEqual({
      header_handle: ["https://example.com/promocion.png"],
    });
  });

  it("consulta el estado de una plantilla en Zernio", async () => {
    const gateway = new ZernioTemplatesGatewayHttp(fakeEnv, fakeLogger);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        template: {
          id: "tpl_meta_9876",
          status: "APPROVED",
        },
      }),
    });
    global.fetch = mockFetch;

    const result = await gateway.fetchTemplateStatus("tpl_meta_9876");

    expect(result.metaTemplateId).toBe("tpl_meta_9876");
    expect(result.status).toBe("APPROVED");
    expect(result.rejectedReason).toBeNull();
  });

  it("elimina una plantilla en Zernio", async () => {
    const gateway = new ZernioTemplatesGatewayHttp(fakeEnv, fakeLogger);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
      }),
    });
    global.fetch = mockFetch;

    const ok = await gateway.deleteTemplate("tpl_meta_9876", "aviso_pago");
    expect(ok).toBe(true);
  });
});
