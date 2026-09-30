import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import type { SystemSettingsRepositoryPort } from "../ports/system-settings.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import {
  type WhatsAppChannelSettings,
  type AiProviderSettings,
  type SystemSetupStatus,
  type TestConnectionResult,
  WhatsAppChannelSettingsSchema,
  AiProviderSettingsSchema,
  maskSecret,
  mergeSecret,
} from "../../domain/system-settings.entity";

const CHANNEL_SETTINGS_KEY = "channels.whatsapp";
const AI_SETTINGS_KEY = "ai.provider";

export class SystemSettingsService {
  private cache = new Map<string, { value: unknown; cachedAt: number }>();
  private readonly CACHE_TTL_MS = 60_000; // 1 minuto de caché en memoria

  constructor(
    private readonly repo: SystemSettingsRepositoryPort,
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly departmentRepo?: DepartmentRepositoryPort,
    private readonly agentRepo?: AgentRepositoryPort,
  ) {}

  public invalidateCache(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  async getChannelSettings(): Promise<WhatsAppChannelSettings> {
    const cached = this.cache.get(CHANNEL_SETTINGS_KEY);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.value as WhatsAppChannelSettings;
    }

    try {
      const dbValue = await this.repo.get<Partial<WhatsAppChannelSettings>>(CHANNEL_SETTINGS_KEY);
      const fallback: WhatsAppChannelSettings = {
        provider: this.env.WHATSAPP_PROVIDER,
        phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID || "",
        wabaId: this.env.META_WABA_ID || "",
        accessToken: this.env.WHATSAPP_ACCESS_TOKEN || "",
        appSecret: this.env.WHATSAPP_APP_SECRET || "",
        verifyToken: this.env.WHATSAPP_VERIFY_TOKEN || "",
        zernioApiKey: this.env.ZERNIO_API_KEY || "",
        zernioAccountId: this.env.ZERNIO_ACCOUNT_ID || "",
        zernioWebhookSecret: this.env.ZERNIO_WEBHOOK_SECRET || "",
        zernioBaseUrl: this.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1",
      };

      const resolved = WhatsAppChannelSettingsSchema.parse({
        ...fallback,
        ...(dbValue || {}),
      });

      this.cache.set(CHANNEL_SETTINGS_KEY, { value: resolved, cachedAt: Date.now() });
      return resolved;
    } catch (err) {
      this.logger.error({ err }, "Error al resolver configuración de canales; usando fallback de entorno");
      return {
        provider: this.env.WHATSAPP_PROVIDER,
        phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID || "",
        wabaId: this.env.META_WABA_ID || "",
        accessToken: this.env.WHATSAPP_ACCESS_TOKEN || "",
        appSecret: this.env.WHATSAPP_APP_SECRET || "",
        verifyToken: this.env.WHATSAPP_VERIFY_TOKEN || "",
        zernioApiKey: this.env.ZERNIO_API_KEY || "",
        zernioAccountId: this.env.ZERNIO_ACCOUNT_ID || "",
        zernioWebhookSecret: this.env.ZERNIO_WEBHOOK_SECRET || "",
        zernioBaseUrl: this.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1",
      };
    }
  }

  async getAiSettings(): Promise<AiProviderSettings> {
    const cached = this.cache.get(AI_SETTINGS_KEY);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.value as AiProviderSettings;
    }

    try {
      const dbValue = await this.repo.get<Partial<AiProviderSettings>>(AI_SETTINGS_KEY);
      const fallback: AiProviderSettings = {
        provider: this.env.AI_PROVIDER,
        geminiApiKey: this.env.GEMINI_API_KEY || "",
        geminiModel: this.env.GEMINI_MODEL || "gemini-2.5-flash",
        geminiEmbeddingModel: this.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004",
        geminiEmbeddingDimension: this.env.GEMINI_EMBEDDING_DIMENSION || 768,
        ollamaBaseUrl: this.env.OLLAMA_BASE_URL || "http://localhost:11434",
        ollamaModel: this.env.OLLAMA_MODEL || "qwen3.5:4b",
        ollamaEmbeddingModel: this.env.OLLAMA_EMBEDDING_MODEL || "qwen3-embedding:4b",
        ollamaEmbeddingDimension: this.env.OLLAMA_EMBEDDING_DIMENSION || 2560,
        aiCallTimeoutMs: this.env.AI_CALL_TIMEOUT_MS || 45000,
        aiQualityTimeoutMs: this.env.AI_QUALITY_TIMEOUT_MS || 600000,
      };

      const resolved = AiProviderSettingsSchema.parse({
        ...fallback,
        ...(dbValue || {}),
      });

      this.cache.set(AI_SETTINGS_KEY, { value: resolved, cachedAt: Date.now() });
      return resolved;
    } catch (err) {
      this.logger.error({ err }, "Error al resolver configuración de IA; usando fallback de entorno");
      return {
        provider: this.env.AI_PROVIDER,
        geminiApiKey: this.env.GEMINI_API_KEY || "",
        geminiModel: this.env.GEMINI_MODEL || "gemini-2.5-flash",
        geminiEmbeddingModel: this.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2",
        geminiEmbeddingDimension: this.env.GEMINI_EMBEDDING_DIMENSION || 768,
        ollamaBaseUrl: this.env.OLLAMA_BASE_URL || "http://localhost:11434",
        ollamaModel: this.env.OLLAMA_MODEL || "qwen3.5:4b",
        ollamaEmbeddingModel: this.env.OLLAMA_EMBEDDING_MODEL || "qwen3-embedding:4b",
        ollamaEmbeddingDimension: this.env.OLLAMA_EMBEDDING_DIMENSION || 2560,
        aiCallTimeoutMs: this.env.AI_CALL_TIMEOUT_MS || 45000,
        aiQualityTimeoutMs: this.env.AI_QUALITY_TIMEOUT_MS || 600000,
      };
    }
  }

  async getMaskedChannelSettings(): Promise<WhatsAppChannelSettings> {
    const raw = await this.getChannelSettings();
    return {
      ...raw,
      accessToken: maskSecret(raw.accessToken),
      appSecret: maskSecret(raw.appSecret),
      verifyToken: maskSecret(raw.verifyToken),
      zernioApiKey: maskSecret(raw.zernioApiKey),
      zernioWebhookSecret: maskSecret(raw.zernioWebhookSecret),
    };
  }

  async getMaskedAiSettings(): Promise<AiProviderSettings> {
    const raw = await this.getAiSettings();
    return {
      ...raw,
      geminiApiKey: maskSecret(raw.geminiApiKey),
    };
  }

  async updateChannelSettings(
    input: Partial<WhatsAppChannelSettings>,
    updatedBy?: string,
  ): Promise<WhatsAppChannelSettings> {
    const current = await this.getChannelSettings();

    const merged = {
      provider: input.provider ?? current.provider,
      phoneNumberId: input.phoneNumberId !== undefined ? input.phoneNumberId.trim() : current.phoneNumberId,
      wabaId: input.wabaId !== undefined ? input.wabaId.trim() : current.wabaId,
      accessToken: mergeSecret(input.accessToken, current.accessToken),
      appSecret: mergeSecret(input.appSecret, current.appSecret),
      verifyToken: mergeSecret(input.verifyToken, current.verifyToken),
      zernioApiKey: mergeSecret(input.zernioApiKey, current.zernioApiKey),
      zernioAccountId: input.zernioAccountId !== undefined ? input.zernioAccountId.trim() : current.zernioAccountId,
      zernioWebhookSecret: mergeSecret(input.zernioWebhookSecret, current.zernioWebhookSecret),
      zernioBaseUrl: input.zernioBaseUrl !== undefined ? input.zernioBaseUrl.trim() : current.zernioBaseUrl,
    };

    const validated = WhatsAppChannelSettingsSchema.parse(merged);
    await this.repo.set(CHANNEL_SETTINGS_KEY, validated, "Configuración de canales de WhatsApp/Zernio", updatedBy);
    this.invalidateCache(CHANNEL_SETTINGS_KEY);
    this.logger.info({ provider: validated.provider }, "Configuración de canales de WhatsApp actualizada exitosamente");

    return this.getMaskedChannelSettings();
  }

  async updateAiSettings(
    input: Partial<AiProviderSettings>,
    updatedBy?: string,
  ): Promise<AiProviderSettings> {
    const current = await this.getAiSettings();

    const merged = {
      provider: input.provider ?? current.provider,
      geminiApiKey: mergeSecret(input.geminiApiKey, current.geminiApiKey),
      geminiModel: input.geminiModel !== undefined ? input.geminiModel.trim() : current.geminiModel,
      geminiEmbeddingModel: input.geminiEmbeddingModel !== undefined ? input.geminiEmbeddingModel.trim() : current.geminiEmbeddingModel,
      geminiEmbeddingDimension: input.geminiEmbeddingDimension ?? current.geminiEmbeddingDimension,
      ollamaBaseUrl: input.ollamaBaseUrl !== undefined ? input.ollamaBaseUrl.trim() : current.ollamaBaseUrl,
      ollamaModel: input.ollamaModel !== undefined ? input.ollamaModel.trim() : current.ollamaModel,
      ollamaEmbeddingModel: input.ollamaEmbeddingModel !== undefined ? input.ollamaEmbeddingModel.trim() : current.ollamaEmbeddingModel,
      ollamaEmbeddingDimension: input.ollamaEmbeddingDimension ?? current.ollamaEmbeddingDimension,
      aiCallTimeoutMs: input.aiCallTimeoutMs ?? current.aiCallTimeoutMs,
      aiQualityTimeoutMs: input.aiQualityTimeoutMs ?? current.aiQualityTimeoutMs,
    };

    const validated = AiProviderSettingsSchema.parse(merged);
    await this.repo.set(AI_SETTINGS_KEY, validated, "Configuración de proveedores de IA y modelos", updatedBy);
    this.invalidateCache(AI_SETTINGS_KEY);
    this.logger.info({ provider: validated.provider, geminiModel: validated.geminiModel, ollamaModel: validated.ollamaModel }, "Configuración de IA actualizada exitosamente");

    return this.getMaskedAiSettings();
  }

  async getSetupStatus(): Promise<SystemSetupStatus> {
    const channels = await this.getChannelSettings();
    const ai = await this.getAiSettings();

    const isMetaConfigured = Boolean(channels.phoneNumberId.trim() && channels.accessToken.trim());
    const isZernioConfigured = Boolean(channels.zernioAccountId.trim() && channels.zernioApiKey.trim());
    const isChannelConfigured = channels.provider === "meta" ? isMetaConfigured : isZernioConfigured;

    const isGeminiConfigured = Boolean(ai.geminiApiKey.trim());
    const isOllamaConfigured = Boolean(ai.ollamaBaseUrl.trim() && ai.ollamaModel.trim());
    const isAiConfigured = ai.provider === "gemini" ? isGeminiConfigured : isOllamaConfigured;

    let hasDepartments = false;
    if (this.departmentRepo) {
      try {
        const depts = await this.departmentRepo.list();
        hasDepartments = depts.length > 0;
      } catch {
        hasDepartments = false;
      }
    }

    let hasAgents = false;
    if (this.agentRepo) {
      try {
        const agents = await this.agentRepo.list();
        hasAgents = agents.length > 0;
      } catch {
        hasAgents = false;
      }
    }

    return {
      isChannelConfigured,
      isAiConfigured,
      hasDepartments,
      hasAgents,
      isInitialSetupComplete: isChannelConfigured && isAiConfigured && hasDepartments && hasAgents,
      activeChannelProvider: channels.provider,
      activeAiProvider: ai.provider,
    };
  }

  /**
   * Prueba en vivo la conexión con el proveedor de IA (Gemini u Ollama).
   */
  async testAiConnection(input?: Partial<AiProviderSettings>): Promise<TestConnectionResult> {
    const current = await this.getAiSettings();
    const provider = input?.provider ?? current.provider;
    const start = Date.now();

    if (provider === "gemini") {
      const apiKey = mergeSecret(input?.geminiApiKey, current.geminiApiKey);
      const model = input?.geminiModel || current.geminiModel || "gemini-2.5-flash";

      if (!apiKey || apiKey.trim() === "") {
        return {
          ok: false,
          latencyMs: 0,
          message: "API Key de Gemini no configurada",
        };
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: "ping" }] }],
            generationConfig: { maxOutputTokens: 2 },
          }),
        }).finally(() => clearTimeout(timer));

        const latencyMs = Date.now() - start;

        if (!res.ok) {
          const errData = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          const msg = errData?.error?.message || `HTTP ${res.status}`;
          return {
            ok: false,
            latencyMs,
            message: `Error en Gemini (${model}): ${msg}`,
          };
        }

        return {
          ok: true,
          latencyMs,
          message: `Conexión exitosa con Gemini (${model})`,
          details: { model, provider: "gemini" },
        };
      } catch (err: unknown) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          message: `Error al conectar con Gemini: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      // Ollama
      const baseUrl = (input?.ollamaBaseUrl || current.ollamaBaseUrl || "http://localhost:11434").replace(/\/$/, "");
      const model = input?.ollamaModel || current.ollamaModel || "qwen3.5:4b";

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7000);
        const url = `${baseUrl}/api/tags`;
        const res = await fetch(url, {
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        const latencyMs = Date.now() - start;

        if (!res.ok) {
          return {
            ok: false,
            latencyMs,
            message: `Ollama HTTP ${res.status}`,
          };
        }

        const data = await res.json().catch(() => null) as { models?: Array<{ name: string }> } | null;
        const availableModels = data?.models?.map((m) => m.name) || [];
        const hasModel = availableModels.some((m) => m === model || m.startsWith(`${model}:`));

        if (!hasModel) {
          return {
            ok: true,
            warning: true,
            latencyMs,
            message: `Ollama conectado, pero el modelo '${model}' no figura descargado (ejecutá: ollama pull ${model})`,
            details: { baseUrl, model, availableModels },
          };
        }

        return {
          ok: true,
          latencyMs,
          message: `Conexión exitosa con Ollama. Modelo '${model}' listo.`,
          details: { baseUrl, model, availableModels },
        };
      } catch (err: unknown) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          message: `Error al conectar con Ollama en ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  /**
   * Prueba en vivo las credenciales del canal de mensajería (Meta Cloud API o Zernio).
   */
  async testChannelConnection(input?: Partial<WhatsAppChannelSettings>): Promise<TestConnectionResult> {
    const current = await this.getChannelSettings();
    const provider = input?.provider ?? current.provider;
    const start = Date.now();

    if (provider === "meta") {
      const phoneNumberId = input?.phoneNumberId?.trim() || current.phoneNumberId;
      const accessToken = mergeSecret(input?.accessToken, current.accessToken);

      if (!phoneNumberId) {
        return {
          ok: false,
          latencyMs: 0,
          message: "Falta configurar Phone Number ID de Meta",
        };
      }
      if (!accessToken) {
        return {
          ok: false,
          latencyMs: 0,
          message: "Falta configurar Access Token de Meta",
        };
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const url = `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        const latencyMs = Date.now() - start;

        if (!res.ok) {
          const errData = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          const msg = errData?.error?.message || `HTTP ${res.status}`;
          return {
            ok: false,
            latencyMs,
            message: `Error Meta Graph API: ${msg}`,
          };
        }

        const data = (await res.json()) as {
          display_phone_number?: string;
          verified_name?: string;
          quality_rating?: string;
          id?: string;
        };

        return {
          ok: true,
          latencyMs,
          message: `Conexión exitosa con Meta Cloud API (${data.display_phone_number || phoneNumberId})`,
          details: {
            phoneNumberId,
            displayPhoneNumber: data.display_phone_number,
            verifiedName: data.verified_name,
            qualityRating: data.quality_rating,
          },
        };
      } catch (err: unknown) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          message: `Error al conectar con Meta Cloud API: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      // Zernio
      const apiKey = mergeSecret(input?.zernioApiKey, current.zernioApiKey);
      const accountId = input?.zernioAccountId?.trim() || current.zernioAccountId;
      const baseUrl = (input?.zernioBaseUrl || current.zernioBaseUrl || "https://zernio.com/api/v1").replace(/\/$/, "");

      if (!apiKey) {
        return {
          ok: false,
          latencyMs: 0,
          message: "Falta configurar Zernio API Key",
        };
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const url = `${baseUrl}/accounts`;
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        const latencyMs = Date.now() - start;

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return {
            ok: false,
            latencyMs,
            message: `Error Zernio API (${res.status}): ${errText.slice(0, 150)}`,
          };
        }

        const data = (await res.json().catch(() => null)) as {
          accounts?: Array<{
            _id: string;
            platform: string;
            metadata?: { wabaId?: string; phoneNumberId?: string };
          }>;
        } | null;

        const accounts = data?.accounts || [];
        const matched = accountId ? accounts.find((a) => a._id === accountId) : accounts[0];

        if (accountId && !matched) {
          return {
            ok: true,
            warning: true,
            latencyMs,
            message: `Zernio API Key válida, pero la cuenta '${accountId}' no figura entre las cuentas accesibles`,
            details: { availableAccountsCount: accounts.length },
          };
        }

        return {
          ok: true,
          latencyMs,
          message: `Conexión exitosa con Zernio API (${accounts.length} cuenta(s) disponible(s))`,
          details: {
            accountsCount: accounts.length,
            targetAccountId: accountId || matched?._id,
          },
        };
      } catch (err: unknown) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          message: `Error al conectar con Zernio API: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }
}
