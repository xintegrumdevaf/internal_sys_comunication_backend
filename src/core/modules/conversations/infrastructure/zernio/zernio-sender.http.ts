import type Redis from "ioredis";
import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import { externalServiceError } from "../../../../../shared/errors/domain-errors";
import { translateDeliveryError } from "../../domain/meta-delivery-error";
import type {
  SendWhatsAppMediaInput,
  SendWhatsAppMediaOutput,
  WhatsAppSenderPort,
} from "../../application/ports/whatsapp-sender.port";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";

type ZernioMessageResponse = {
  id?: string;
  messageId?: string;
  platformMessageId?: string;
  success?: boolean;
  message?: string;
  data?: {
    messageId?: string;
    conversationId?: string;
    participantId?: string;
  };
};

type ZernioConversationItem = {
  id?: string;
  _id?: string;
  conversationId?: string;
  accountId?: string;
  participantId?: string;
  participantUsername?: string;
  participantPhone?: string;
  phone?: string;
  recipientId?: string;
  recipient?: string | { id?: string; phone?: string; username?: string };
  participant?: string | { id?: string; phone?: string; username?: string };
  to?: string;
  metadata?: {
    phone?: string;
    participantId?: string;
    to?: string;
    recipient?: string;
  };
};

/**
 * Adapter para envío de mensajes vía API de Zernio (docs/spec/00_OVERVIEW.md regla #2).
 * Implementa WhatsAppSenderPort desacoplado de la API nativa de Meta.
 */
export class ZernioSenderHttp implements WhatsAppSenderPort {
  private resolvedAccountId: string | null = null;
  private lastInputAccountId: string | null = null;
  private readonly conversationIdCache = new Map<string, string>();
  private readonly phoneByConversationIdCache = new Map<string, string>();

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly fallbackSender?: WhatsAppSenderPort,
    private readonly settingsService?: SystemSettingsService,
    private readonly redisClient?: Redis,
  ) {
    if (this.env.ZERNIO_ACCOUNT_ID?.trim()) {
      this.resolvedAccountId = this.env.ZERNIO_ACCOUNT_ID.trim();
      this.lastInputAccountId = this.resolvedAccountId;
    }
  }

  private async resolveConfig(): Promise<{ baseUrl: string; apiKey: string; accountId: string }> {
    let baseUrl = (this.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1").replace(/\/$/, "");
    let apiKey = this.env.ZERNIO_API_KEY || "";
    let accountId = this.env.ZERNIO_ACCOUNT_ID?.trim() || "";

    if (this.settingsService) {
      try {
        const s = await this.settingsService.getChannelSettings();
        if (s.zernioBaseUrl) baseUrl = s.zernioBaseUrl.replace(/\/$/, "");
        if (s.zernioApiKey) apiKey = s.zernioApiKey;
        if (s.zernioAccountId) accountId = s.zernioAccountId.trim();
      } catch {
        // Fallback a env
      }
    }

    return { baseUrl, apiKey, accountId };
  }

  public isBusinessAccount(phone: string): boolean {
    const clean = phone.replace(/\D/g, "");
    if (!clean) return false;
    if (clean.length > 14 && (clean.startsWith("1042") || clean.startsWith("1348") || clean.startsWith("3223"))) {
      return true;
    }
    if (this.env.WHATSAPP_PHONE_NUMBER_ID && clean === this.env.WHATSAPP_PHONE_NUMBER_ID.trim()) {
      return true;
    }
    if (this.env.ZERNIO_ACCOUNT_ID && clean === this.env.ZERNIO_ACCOUNT_ID.trim()) {
      return true;
    }
    return false;
  }

  /**
   * Genera todas las variaciones posibles de un número de teléfono (internacional 593, local con 0, nacional de 9 dígitos).
   */
  public getPhoneVariations(phone: string): string[] {
    const clean = phone.replace(/\D/g, "");
    if (!clean) return [];
    const set = new Set<string>();
    set.add(clean);

    if (clean.startsWith("593") && clean.length >= 11) {
      const national = clean.substring(3); // ej: 995848829
      set.add(national);
      set.add(`0${national}`); // ej: 0995848829
    } else if (clean.startsWith("09") && clean.length === 10) {
      const national = clean.substring(1); // ej: 995848829
      set.add(national);
      set.add(`593${national}`); // ej: 593995848829
    } else if (clean.startsWith("9") && clean.length === 9) {
      set.add(`0${clean}`); // ej: 0995848829
      set.add(`593${clean}`); // ej: 593995848829
    }

    return Array.from(set);
  }

  /**
   * Extrae el ID de conversación de un objeto devuelto por Zernio (soporta id, _id y conversationId).
   */
  public extractConversationId(item: unknown): string | null {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    const rawId = obj.id || obj._id || obj.conversationId;
    return typeof rawId === "string" && rawId.trim() ? rawId.trim() : null;
  }

  /**
   * Extrae el número del participante desde múltiples campos posibles de Zernio.
   */
  public extractParticipantPhone(item: unknown): string | null {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    const raw =
      obj.participantId ||
      obj.participantUsername ||
      obj.participantPhone ||
      (typeof obj.participant === "string" ? obj.participant : undefined) ||
      (typeof obj.participant === "object" && obj.participant !== null
        ? (obj.participant as Record<string, unknown>).phone || (obj.participant as Record<string, unknown>).id
        : undefined) ||
      obj.recipientId ||
      (typeof obj.recipient === "string" ? obj.recipient : undefined) ||
      (typeof obj.recipient === "object" && obj.recipient !== null
        ? (obj.recipient as Record<string, unknown>).phone || (obj.recipient as Record<string, unknown>).id
        : undefined) ||
      obj.phone ||
      obj.to ||
      (typeof (obj.metadata as Record<string, unknown>)?.phone === "string"
        ? (obj.metadata as Record<string, unknown>).phone
        : undefined) ||
      (typeof (obj.metadata as Record<string, unknown>)?.participantId === "string"
        ? (obj.metadata as Record<string, unknown>).participantId
        : undefined);

    if (typeof raw !== "string" && typeof raw !== "number") return null;
    const clean = String(raw).replace(/\D/g, "");
    return clean.length >= 7 ? clean : null;
  }

  /**
   * Guarda o actualiza la asociación de un teléfono con su ID de conversación en Zernio.
   * Registra automáticamente todas las variantes del número (593..., 09..., 9...) tanto
   * en el caché en memoria como en Redis con TTL de 30 días.
   */
  public registerConversation(waPhone: string, conversationId: string): void {
    if (!waPhone || !conversationId) return;
    const variations = this.getPhoneVariations(waPhone);
    const validVariations = variations.filter((v) => !this.isBusinessAccount(v));
    if (validVariations.length === 0) return;

    for (const v of validVariations) {
      this.conversationIdCache.set(v, conversationId);
    }
    this.phoneByConversationIdCache.set(conversationId, validVariations[0]!);

    if (this.redisClient) {
      for (const v of validVariations) {
        void this.redisClient
          .set(`zernio:conv:${v}`, conversationId, "EX", 30 * 86400)
          .catch((err) => {
            this.logger.warn({ err, phone: v, conversationId }, "No se pudo guardar conversationId en Redis");
          });
      }
      void this.redisClient
        .set(`zernio:phone:${conversationId}`, validVariations[0]!, "EX", 30 * 86400)
        .catch(() => {});
    }
  }

  public getPhoneByConversationId(conversationId: string): string | null {
    return this.phoneByConversationIdCache.get(conversationId) || null;
  }

  public async resolvePhoneByConversationId(conversationId: string): Promise<string | null> {
    if (!conversationId) return null;
    const existing = this.phoneByConversationIdCache.get(conversationId);
    if (existing) {
      return existing;
    }

    if (this.redisClient) {
      try {
        const fromRedis = await this.redisClient.get(`zernio:phone:${conversationId}`);
        if (fromRedis) {
          const variations = this.getPhoneVariations(fromRedis);
          for (const v of variations) {
            this.conversationIdCache.set(v, conversationId);
          }
          this.phoneByConversationIdCache.set(conversationId, fromRedis);
          return fromRedis;
        }
      } catch {
        // Fallback a API de Zernio
      }
    }

    try {
      const config = await this.resolveConfig();
      const accountId = await this.getAccountId().catch(() => "");
      const url = accountId
        ? `${config.baseUrl}/inbox/conversations?accountId=${encodeURIComponent(accountId)}&limit=100`
        : `${config.baseUrl}/inbox/conversations?platform=whatsapp&limit=100`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });

      if (res.ok) {
        const body = (await res.json()) as { data?: unknown[]; conversations?: unknown[] } | unknown[];
        const items = Array.isArray(body)
          ? body
          : Array.isArray(body?.data)
            ? body.data
            : Array.isArray(body?.conversations)
              ? body.conversations
              : [];

        for (const item of items) {
          const convId = this.extractConversationId(item);
          const participant = this.extractParticipantPhone(item);
          if (convId && participant && !this.isBusinessAccount(participant)) {
            this.registerConversation(participant, convId);
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "No se pudo resolver el teléfono desde Zernio por conversationId");
    }

    return this.phoneByConversationIdCache.get(conversationId) || null;
  }

  private async getAccountId(forceRefresh = false): Promise<string> {
    const config = await this.resolveConfig();
    if (this.resolvedAccountId && !forceRefresh && this.lastInputAccountId === config.accountId) {
      return this.resolvedAccountId;
    }

    const inputId = config.accountId;
    this.lastInputAccountId = inputId;
    const url = `${config.baseUrl}/accounts`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      this.logger.error({ status: res.status, body: errText }, "Error al listar cuentas de Zernio");
      throw new Error(`Zernio accounts lookup fallo (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      accounts?: Array<{
        _id: string;
        platform: string;
        metadata?: { wabaId?: string; phoneNumberId?: string };
      }>;
    };

    const accounts = data.accounts || [];
    const matched = accounts.find(
      (a) =>
        a._id === inputId ||
        a.metadata?.wabaId === inputId ||
        a.metadata?.phoneNumberId === inputId ||
        a.platform === "whatsapp",
    );

    if (!matched) {
      throw new Error(
        `No se encontro ninguna cuenta de WhatsApp en Zernio para el identificador: ${inputId || "(vacio)"}`,
      );
    }

    this.resolvedAccountId = matched._id;
    return this.resolvedAccountId;
  }

  /**
   * Búsqueda activa de una conversación en Zernio por teléfono exacto, con prefijos y paginación a fondo.
   */
  public async searchConversationInZernio(cleanPhone: string): Promise<string | null> {
    try {
      const config = await this.resolveConfig();
      const accountId = await this.getAccountId();
      const variations = this.getPhoneVariations(cleanPhone);

      const indexItems = (items: unknown[]): string | null => {
        let matchedId: string | null = null;
        for (const raw of items) {
          const convId = this.extractConversationId(raw);
          const participant = this.extractParticipantPhone(raw);
          if (convId && participant && !this.isBusinessAccount(participant)) {
            this.registerConversation(participant, convId);
            const partVariations = this.getPhoneVariations(participant);
            if (variations.some((target) => partVariations.includes(target))) {
              matchedId = convId;
            }
          }
        }
        return matchedId;
      };

      // 1. Probar endpoints con parámetro search para cada variación
      for (const term of variations) {
        const searchUrl = `${config.baseUrl}/inbox/conversations?accountId=${encodeURIComponent(accountId)}&search=${encodeURIComponent(term)}`;
        try {
          const res = await fetch(searchUrl, {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
          });

          if (res.ok) {
            const body = (await res.json()) as { data?: unknown[]; conversations?: unknown[] } | unknown[];
            const items = Array.isArray(body)
              ? body
              : Array.isArray(body?.data)
                ? body.data
                : Array.isArray(body?.conversations)
                  ? body.conversations
                  : [];
            const foundId = indexItems(items);
            if (foundId) {
              this.logger.info({ cleanPhone, foundId, term }, "Conversación encontrada en Zernio vía search");
              return foundId;
            }
          }
        } catch (err) {
          this.logger.debug({ err, term }, "Fallo búsqueda puntual con search en Zernio");
        }
      }

      // 2. Si search no la indexó, paginar listado de conversaciones con cursor (hasta 5 páginas = 500 chats)
      let cursor: string | null = null;
      let hasMore = true;
      let page = 0;
      const MAX_PAGES = 5;

      while (hasMore && page < MAX_PAGES) {
        page++;
        let listUrl = `${config.baseUrl}/inbox/conversations?accountId=${encodeURIComponent(accountId)}&limit=100`;
        if (cursor) {
          listUrl += `&cursor=${encodeURIComponent(cursor)}`;
        }

        const listRes = await fetch(listUrl, {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
        });

        if (!listRes.ok) {
          break;
        }

        const body = (await listRes.json()) as {
          data?: unknown[];
          conversations?: unknown[];
          pagination?: { hasMore?: boolean; nextCursor?: string };
        } | unknown[];

        const items = Array.isArray(body)
          ? body
          : Array.isArray(body?.data)
            ? body.data
            : Array.isArray(body?.conversations)
              ? body.conversations
              : [];

        const foundId = indexItems(items);
        if (foundId) {
          this.logger.info({ cleanPhone, foundId, page }, "Conversación encontrada en Zernio vía paginación");
          return foundId;
        }

        if (!Array.isArray(body) && body?.pagination?.hasMore && body.pagination.nextCursor) {
          cursor = body.pagination.nextCursor;
        } else {
          hasMore = false;
        }
      }
    } catch (err) {
      this.logger.warn({ err, cleanPhone }, "No se pudo sincronizar cache de conversaciones de Zernio");
    }

    // Verificar si alguna variación quedó registrada en memoria
    const variations = this.getPhoneVariations(cleanPhone);
    for (const v of variations) {
      const id = this.conversationIdCache.get(v);
      if (id) return id;
    }

    return null;
  }

  /**
   * Precarga en segundo plano las conversaciones más recientes de Zernio para poblar
   * de inmediato el caché de Redis y memoria tras el arranque del sistema.
   */
  public async preloadRecentConversations(): Promise<void> {
    try {
      const config = await this.resolveConfig();
      if (!config.apiKey) return;
      const accountId = await this.getAccountId().catch(() => "");
      let cursor: string | null = null;
      let pages = 0;

      while (pages < 3) {
        pages++;
        let url = accountId
          ? `${config.baseUrl}/inbox/conversations?accountId=${encodeURIComponent(accountId)}&limit=100`
          : `${config.baseUrl}/inbox/conversations?platform=whatsapp&limit=100`;
        if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        if (!res.ok) break;

        const body = (await res.json()) as {
          data?: unknown[];
          conversations?: unknown[];
          pagination?: { hasMore?: boolean; nextCursor?: string };
        } | unknown[];

        const items = Array.isArray(body)
          ? body
          : Array.isArray(body?.data)
            ? body.data
            : Array.isArray(body?.conversations)
              ? body.conversations
              : [];

        for (const item of items) {
          const convId = this.extractConversationId(item);
          const phone = this.extractParticipantPhone(item);
          if (convId && phone && !this.isBusinessAccount(phone)) {
            this.registerConversation(phone, convId);
          }
        }

        if (!Array.isArray(body) && body?.pagination?.hasMore && body.pagination.nextCursor) {
          cursor = body.pagination.nextCursor;
        } else {
          break;
        }
      }
      this.logger.info("Precarga de conversaciones activas de Zernio completada con éxito");
    } catch (err) {
      this.logger.warn({ err }, "No se pudo precargar conversaciones de Zernio en arranque");
    }
  }

  private async resolveConversationId(cleanPhone: string): Promise<string | null> {
    const variations = this.getPhoneVariations(cleanPhone);

    // 1. Intentar recuperar desde memoria local para cualquiera de las variaciones
    for (const v of variations) {
      const cached = this.conversationIdCache.get(v);
      if (cached) {
        return cached;
      }
    }

    // 2. Intentar recuperar desde Redis para cualquiera de las variaciones
    if (this.redisClient) {
      for (const v of variations) {
        try {
          const fromRedis = await this.redisClient.get(`zernio:conv:${v}`);
          if (fromRedis) {
            for (const itemVar of variations) {
              this.conversationIdCache.set(itemVar, fromRedis);
            }
            this.phoneByConversationIdCache.set(fromRedis, v);
            return fromRedis;
          }
        } catch (err) {
          this.logger.warn({ err, phone: v }, "Error al consultar cache de Redis para Zernio conversationId");
        }
      }
    }

    // 3. Búsqueda activa a fondo en la API de Zernio
    return this.searchConversationInZernio(cleanPhone);
  }

  async sendText(waPhone: string, body: string): Promise<{ externalId: string }> {
    const config = await this.resolveConfig();
    const cleanPhone = waPhone.replace(/\D/g, "");
    const accountId = await this.getAccountId();
    const existingConversationId = await this.resolveConversationId(cleanPhone);

    let url: string;
    let payload: Record<string, unknown>;

    if (existingConversationId) {
      url = `${config.baseUrl}/inbox/conversations/${existingConversationId}/messages`;
      payload = {
        accountId,
        message: body,
      };
    } else {
      url = `${config.baseUrl}/inbox/conversations`;
      payload = {
        accountId,
        participantId: cleanPhone,
        message: body,
      };
    }

    this.logger.info({ waPhone: cleanPhone, hasExistingConv: !!existingConversationId }, "Enviando texto via Zernio");

    let response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (
        response.status === 404 &&
        (errorBody.toLowerCase().includes("conversation not found") || errorBody.toLowerCase().includes("conversation_not_found"))
      ) {
        this.logger.warn(
          { existingConversationId, cleanPhone, errorBody },
          "Conversación de Zernio no encontrada en inbox, reintentando creando conversación con participantId...",
        );
        this.conversationIdCache.delete(cleanPhone);
        if (existingConversationId) {
          this.phoneByConversationIdCache.delete(existingConversationId);
        }
        url = `${config.baseUrl}/inbox/conversations`;
        payload = {
          accountId,
          participantId: cleanPhone,
          message: body,
        };
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const secondErr = await response.text();
          if (response.status === 429) {
            this.logger.error({ status: 429, body: secondErr }, "Zernio API tasa de envíos excedida (429 Rate Limit)");
            throw externalServiceError(
              `Límite de solicitudes alcanzado en Zernio (429): ${secondErr || "Por favor espere unos segundos antes de reintentar."}`,
              { retryable: true },
            );
          }
          if (this.fallbackSender) {
            this.logger.warn(
              { cleanPhone, secondErr },
              "Zernio no pudo abrir conversación; entregando directamente vía Meta Cloud API...",
            );
            return this.fallbackSender.sendText(waPhone, body);
          }
          this.logger.error({ status: response.status, body: secondErr }, "Zernio API rechazo el envio tras reintento de conversacion");
          throw externalServiceError(`Zernio sendText fallo (${response.status}): ${secondErr}`);
        }
      } else if (
        response.status === 404 &&
        (errorBody.toLowerCase().includes("account not found") || errorBody.toLowerCase().includes("account_not_found"))
      ) {
        this.logger.warn(
          { accountId, errorBody },
          "Cuenta de Zernio no valida o desactualizada, reintentando con resolucion dinamica...",
        );
        const refreshedAccountId = await this.getAccountId(true);
        payload.accountId = refreshedAccountId;
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const secondErr = await response.text();
          if (this.fallbackSender) {
            this.logger.warn(
              { cleanPhone, secondErr },
              "Zernio fallo tras refrescar cuenta; entregando directamente vía Meta Cloud API...",
            );
            return this.fallbackSender.sendText(waPhone, body);
          }
          this.logger.error({ status: response.status, body: secondErr }, "Zernio API rechazo el envio tras reintento");
          throw new Error(`Zernio sendText fallo (${response.status}): ${secondErr}`);
        }
      } else if (
        !existingConversationId &&
        response.status === 400 &&
        (errorBody.includes("TEMPLATE_REQUIRED") || errorBody.toLowerCase().includes("template"))
      ) {
        this.logger.warn(
          { cleanPhone, errorBody },
          "Zernio reportó TEMPLATE_REQUIRED al crear conversación. Reintentando búsqueda a fondo de conversación existente...",
        );
        const recoveredId = await this.searchConversationInZernio(cleanPhone);
        if (recoveredId) {
          this.logger.info(
            { cleanPhone, recoveredId },
            "Conversación existente recuperada en Zernio; reintentando entrega del mensaje a la conversación...",
          );
          url = `${config.baseUrl}/inbox/conversations/${recoveredId}/messages`;
          payload = {
            accountId,
            message: body,
          };
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const retryErr = await response.text();
            if (this.fallbackSender) {
              this.logger.warn(
                { cleanPhone, retryErr },
                "Zernio falló tras reintento en conversación recuperada; entregando vía Meta Cloud API...",
              );
              return this.fallbackSender.sendText(waPhone, body);
            }
            this.logger.error({ status: response.status, body: retryErr }, "Fallo tras reintento en conversación recuperada de Zernio");
            throw externalServiceError(`Zernio sendText fallo (${response.status}): ${retryErr}`);
          }
        } else {
          if (this.fallbackSender) {
            this.logger.warn(
              { cleanPhone, errorBody },
              "Zernio reportó TEMPLATE_REQUIRED y no se encontró conversación existente; entregando vía Meta Cloud API...",
            );
            return this.fallbackSender.sendText(waPhone, body);
          }
          this.logger.error({ status: response.status, body: errorBody }, "Zernio API rechazo el envio de mensaje (TEMPLATE_REQUIRED)");
          throw externalServiceError(`Zernio sendText fallo (${response.status}): ${errorBody}`);
        }
      } else {
        if (response.status === 429) {
          this.logger.error({ status: 429, body: errorBody }, "Zernio API tasa de envíos excedida (429 Rate Limit)");
          throw externalServiceError(
            `Límite de solicitudes alcanzado en Zernio (429): ${errorBody || "Por favor espere unos segundos antes de reintentar."}`,
            { retryable: true },
          );
        }

        if (this.fallbackSender) {
          this.logger.warn(
            { cleanPhone, status: response.status, errorBody },
            "Zernio API rechazó el envío (ej. TEMPLATE_REQUIRED); entregando directamente vía Meta Cloud API...",
          );
          return this.fallbackSender.sendText(waPhone, body);
        }
        this.logger.error({ status: response.status, body: errorBody }, "Zernio API rechazo el envio de mensaje");
        throw externalServiceError(`Zernio sendText fallo (${response.status}): ${errorBody}`);
      }
    }

    const data = (await response.json()) as ZernioMessageResponse & {
      data?: { id?: string; conversationId?: string; messageId?: string };
    };

    const externalId =
      data.platformMessageId ||
      data.messageId ||
      data.id ||
      data.data?.messageId ||
      data.data?.id;

    if (!externalId) {
      this.logger.warn({ data }, "Respuesta de Zernio sin externalId explicito, usando timestamp");
      return { externalId: `zernio-${Date.now()}` };
    }

    if (data.data?.conversationId && !existingConversationId) {
      this.registerConversation(cleanPhone, data.data.conversationId);
    }

    return { externalId };
  }

  private async uploadMediaToZernio(
    input: SendWhatsAppMediaInput,
    config: { baseUrl: string; apiKey: string; accountId: string },
  ): Promise<string> {
    if (
      input.mediaUrl &&
      /^https:\/\//i.test(input.mediaUrl) &&
      !input.mediaUrl.includes("localhost") &&
      !input.mediaUrl.includes("127.0.0.1")
    ) {
      return input.mediaUrl;
    }

    const defaultExt =
      input.type === "image"
        ? "jpg"
        : input.type === "video"
          ? "mp4"
          : input.type === "audio"
            ? "ogg"
            : "pdf";
    const filename = (input.filename || `adjunto-${Date.now()}.${defaultExt}`).trim();
    const mimeType = (input.mimeType || "application/octet-stream").split(";")[0]?.trim() || "application/octet-stream";

    const extractPublicUrl = (raw: unknown): string | null => {
      if (!raw || typeof raw !== "object") return null;
      const obj = raw as Record<string, unknown>;
      const dataObj = (obj.data && typeof obj.data === "object" ? obj.data : undefined) as
        | Record<string, unknown>
        | undefined;
      const filesArr = (Array.isArray(obj.files) ? obj.files : Array.isArray(dataObj?.files) ? dataObj?.files : undefined) as
        | Array<Record<string, unknown>>
        | undefined;

      const candidate =
        obj.publicUrl ??
        obj.url ??
        obj.fileUrl ??
        obj.mediaUrl ??
        dataObj?.publicUrl ??
        dataObj?.url ??
        dataObj?.fileUrl ??
        dataObj?.mediaUrl ??
        filesArr?.[0]?.publicUrl ??
        filesArr?.[0]?.url;

      return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
    };

    // 1. Subida directa (/media/upload-direct) para archivos <= 4 MB
    if (input.buffer.length <= 4 * 1024 * 1024) {
      try {
        const form = new FormData();
        const blob = new Blob([new Uint8Array(input.buffer)], { type: mimeType });
        form.append("file", blob, filename);
        if (mimeType !== "application/octet-stream") {
          form.append("contentType", mimeType);
        }

        const directRes = await fetch(`${config.baseUrl}/media/upload-direct`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: form,
        });

        if (directRes.ok) {
          const directJson = await directRes.json();
          const url = extractPublicUrl(directJson);
          if (url) return url;
        } else {
          const errText = await directRes.text();
          this.logger.warn(
            { status: directRes.status, body: errText, filename, mimeType },
            "Zernio /media/upload-direct no acepto el archivo; intentando /media/presign",
          );
        }
      } catch (err) {
        this.logger.warn({ err, filename }, "Fallo llamada a Zernio /media/upload-direct; intentando /media/presign");
      }
    }

    // 2. Presigned URL (/media/presign) + PUT binario directo al storage de Zernio
    try {
      const presignRes = await fetch(`${config.baseUrl}/media/presign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          filename,
          contentType: mimeType === "application/octet-stream" ? "application/pdf" : mimeType,
          size: input.buffer.length,
        }),
      });

      if (presignRes.ok) {
        const presignJson = (await presignRes.json()) as {
          uploadUrl?: string;
          publicUrl?: string;
          url?: string;
          data?: { uploadUrl?: string; publicUrl?: string; url?: string };
        };
        const uploadUrl = presignJson.uploadUrl || presignJson.data?.uploadUrl;
        const publicUrl =
          presignJson.publicUrl ||
          presignJson.url ||
          presignJson.data?.publicUrl ||
          presignJson.data?.url;

        if (uploadUrl && publicUrl) {
          const putRes = await fetch(uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Type":
                input.type === "sticker"
                  ? "image/webp"
                  : mimeType === "application/octet-stream"
                    ? "application/pdf"
                    : mimeType,
            },
            body: new Uint8Array(input.buffer),
          });
          if (putRes.ok) {
            return publicUrl;
          }
          const putErr = await putRes.text();
          this.logger.warn({ status: putRes.status, body: putErr }, "Fallo PUT a uploadUrl de Zernio presign");
        }
      } else {
        const errText = await presignRes.text();
        this.logger.warn({ status: presignRes.status, body: errText }, "Zernio /media/presign rechazo la solicitud");
      }
    } catch (err) {
      this.logger.warn({ err, filename }, "Fallo flujo /media/presign en Zernio");
    }

    // 3. Fallback a /media/upload multipart
    const fallbackForm = new FormData();
    const fallbackBlob = new Blob([new Uint8Array(input.buffer)], { type: mimeType });
    fallbackForm.append("file", fallbackBlob, filename);

    const uploadRes = await fetch(`${config.baseUrl}/media/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: fallbackForm,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Zernio media upload fallo (${uploadRes.status}): ${errText}`);
    }

    const uploadJson = await uploadRes.json();
    const finalUrl = extractPublicUrl(uploadJson);
    if (!finalUrl) {
      throw new Error("Zernio media upload no devolvio una URL publica valida");
    }
    return finalUrl;
  }

  async sendMedia(input: SendWhatsAppMediaInput): Promise<SendWhatsAppMediaOutput> {
    const config = await this.resolveConfig();
    const cleanPhone = input.waPhone.replace(/\D/g, "");

    let attachmentUrl: string;
    try {
      attachmentUrl = await this.uploadMediaToZernio(input, config);
    } catch (uploadError) {
      if (this.fallbackSender?.sendMedia) {
        this.logger.warn(
          { err: uploadError, cleanPhone, type: input.type },
          "Subida de media en Zernio fallo; entregando directamente via Meta Cloud API...",
        );
        return this.fallbackSender.sendMedia(input);
      }
      throw uploadError;
    }

    const accountId = await this.getAccountId();
    const existingConversationId = await this.resolveConversationId(cleanPhone);
    const zernioAttachmentType = input.type === "document" ? "file" : input.type;
    const captionText = input.caption?.trim() || "";

    const buildPayload = (accId: string, includeParticipant: boolean): Record<string, unknown> => ({
      accountId: accId,
      ...(includeParticipant ? { participantId: cleanPhone } : {}),
      ...(captionText && input.type !== "sticker" ? { message: captionText } : {}),
      attachmentUrl,
      attachmentType: zernioAttachmentType,
      ...(input.filename ? { attachmentName: input.filename } : {}),
      ...(input.type === "audio" && input.voiceNote ? { voiceNote: true } : {}),
    });

    let url = existingConversationId
      ? `${config.baseUrl}/inbox/conversations/${existingConversationId}/messages`
      : `${config.baseUrl}/inbox/conversations`;
    let payload = buildPayload(accountId, !existingConversationId);

    this.logger.info(
      { waPhone: cleanPhone, type: input.type, zernioAttachmentType, hasExistingConv: !!existingConversationId },
      "Enviando archivo multimedia via Zernio",
    );

    let response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (
        response.status === 404 &&
        (errorBody.toLowerCase().includes("conversation not found") ||
          errorBody.toLowerCase().includes("conversation_not_found"))
      ) {
        this.conversationIdCache.delete(cleanPhone);
        if (existingConversationId) {
          this.phoneByConversationIdCache.delete(existingConversationId);
        }
        url = `${config.baseUrl}/inbox/conversations`;
        payload = buildPayload(accountId, true);
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
      } else if (
        !existingConversationId &&
        response.status === 400 &&
        (errorBody.includes("TEMPLATE_REQUIRED") || errorBody.toLowerCase().includes("template"))
      ) {
        this.logger.warn(
          { cleanPhone, errorBody },
          "Zernio reportó TEMPLATE_REQUIRED al crear conversación para media. Reintentando búsqueda de conversación existente...",
        );
        const recoveredId = await this.searchConversationInZernio(cleanPhone);
        if (recoveredId) {
          this.logger.info(
            { cleanPhone, recoveredId },
            "Conversación existente recuperada en Zernio; reintentando entrega de media a la conversación...",
          );
          url = `${config.baseUrl}/inbox/conversations/${recoveredId}/messages`;
          payload = buildPayload(accountId, false);
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(payload),
          });
        }
      } else if (
        response.status === 404 &&
        (errorBody.toLowerCase().includes("account not found") ||
          errorBody.toLowerCase().includes("account_not_found"))
      ) {
        const refreshedAccountId = await this.getAccountId(true);
        payload = buildPayload(refreshedAccountId, !existingConversationId);
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
      }

      if (!response.ok) {
        const secondErr = await response.text().catch(() => errorBody);
        if (response.status === 429) {
          this.logger.error({ status: 429, body: secondErr, type: input.type }, "Zernio API tasa de envíos excedida al enviar media (429 Rate Limit)");
          throw externalServiceError(
            `Límite de solicitudes alcanzado en Zernio (429): ${secondErr || "Por favor espere unos segundos antes de reintentar."}`,
            { retryable: true },
          );
        }
        if (this.fallbackSender?.sendMedia) {
          this.logger.warn(
            { cleanPhone, status: response.status, secondErr, type: input.type },
            "Zernio rechazo el envio de media; entregando directamente via Meta Cloud API...",
          );
          return this.fallbackSender.sendMedia(input);
        }
        this.logger.error(
          { status: response.status, body: secondErr, type: input.type },
          "Zernio API rechazo el envio de archivo multimedia",
        );
        throw externalServiceError(`Zernio sendMedia fallo (${response.status}): ${secondErr}`);
      }
    }

    const data = (await response.json()) as ZernioMessageResponse & {
      data?: { id?: string; conversationId?: string; messageId?: string };
    };

    const externalId =
      data.platformMessageId ||
      data.messageId ||
      data.id ||
      data.data?.messageId ||
      data.data?.id ||
      `zernio-media-${Date.now()}`;

    if (data.data?.conversationId && !existingConversationId) {
      this.registerConversation(cleanPhone, data.data.conversationId);
    }

    return {
      externalId,
      remoteMediaId: attachmentUrl,
    };
  }

  async sendTemplate(
    waPhone: string,
    templateName: string,
    languageCode = "es",
    parameters: string[] = [],
  ): Promise<{ externalId: string }> {
    const config = await this.resolveConfig();
    const cleanPhone = waPhone.replace(/\D/g, "");
    const accountId = await this.getAccountId();

    const url = `${config.baseUrl}/inbox/conversations`;
    const payload: Record<string, unknown> = {
      accountId,
      participantId: cleanPhone,
      templateName,
      templateLanguage: languageCode,
    };

    if (parameters.length > 0) {
      // Meta prohíbe saltos de línea dentro de los valores de los parámetros de plantilla
      const sanitizedParams = parameters.map((p) =>
        String(p ?? "")
          .replace(/[\r\n]+/g, " ")
          .trim(),
      );
      payload.templateParams = sanitizedParams;
    }

    this.logger.info({ waPhone: cleanPhone, templateName }, "Enviando plantilla via Zernio");

    let response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (
        response.status === 404 &&
        (errorBody.toLowerCase().includes("account not found") || errorBody.toLowerCase().includes("account_not_found"))
      ) {
        this.logger.warn(
          { accountId, errorBody },
          "Cuenta de Zernio no valida o desactualizada en template, reintentando con resolucion dinamica...",
        );
        const refreshedAccountId = await this.getAccountId(true);
        payload.accountId = refreshedAccountId;
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const secondErr = await response.text();
          if (this.fallbackSender) {
            this.logger.warn(
              { cleanPhone, templateName, secondErr },
              "Zernio falló plantilla tras refrescar cuenta; entregando vía Meta Cloud API...",
            );
            return this.fallbackSender.sendTemplate(waPhone, templateName, languageCode, parameters);
          }
          this.logger.error({ status: response.status, body: secondErr }, "Zernio API rechazo el envio de plantilla tras reintento");
          throw new Error(`Zernio sendTemplate fallo (${response.status}): ${secondErr}`);
        }
      } else {
        if (response.status === 429) {
          this.logger.error({ status: 429, body: errorBody }, "Zernio API tasa de envíos excedida al enviar plantilla (429 Rate Limit)");
          throw externalServiceError(
            `Límite de solicitudes alcanzado en Zernio (429): ${errorBody || "Por favor espere unos segundos antes de reintentar."}`,
            { retryable: true },
          );
        }
        if (this.fallbackSender) {
          this.logger.warn(
            { cleanPhone, templateName, status: response.status, errorBody },
            "Zernio API rechazó la plantilla; entregando vía Meta Cloud API...",
          );
          return this.fallbackSender.sendTemplate(waPhone, templateName, languageCode, parameters);
        }
        this.logger.error({ status: response.status, body: errorBody }, "Zernio API rechazo el envio de plantilla");
        throw externalServiceError(`Zernio sendTemplate fallo (${response.status}): ${errorBody}`);
      }
    }

    const data = (await response.json()) as ZernioMessageResponse & {
      data?: { id?: string; conversationId?: string; messageId?: string };
    };
    const externalId =
      data.data?.messageId ||
      data.platformMessageId ||
      data.messageId ||
      data.id ||
      `zernio-tpl-${Date.now()}`;

    const convId = data.data?.conversationId || data.data?.id;
    if (convId) {
      this.registerConversation(cleanPhone, convId);
    }

    return { externalId };
  }

  async checkMessageStatus(
    waPhone: string,
    externalId: string,
  ): Promise<{ status: "sent" | "delivered" | "failed"; errorMessage?: string } | null> {
    try {
      const config = await this.resolveConfig();
      const cleanPhone = waPhone.replace(/\D/g, "");
      const accountId = await this.getAccountId();
      const convId = await this.resolveConversationId(cleanPhone);
      if (!convId) return null;

      const url = `${config.baseUrl}/inbox/conversations/${convId}/messages?accountId=${accountId}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });

      if (!res.ok) return null;

      const data = (await res.json()) as {
        messages?: Array<{
          id?: string;
          deliveryStatus?: string;
          deliveryError?: { code?: number; message?: string; details?: string; title?: string };
        }>;
      };

      const matched = (data.messages || []).find((m) => m.id === externalId);
      if (matched) {
        if (matched.deliveryStatus === "failed") {
          const rawDetail =
            matched.deliveryError?.details ||
            matched.deliveryError?.message ||
            matched.deliveryError?.title ||
            "Error de entrega en Meta / WhatsApp";
          const translatedError = translateDeliveryError(rawDetail, matched.deliveryError?.code);
          return { status: "failed", errorMessage: translatedError };
        }
        if (matched.deliveryStatus === "delivered" || matched.deliveryStatus === "read") {
          return { status: "delivered" };
        }
        return { status: "sent" };
      }
    } catch (err) {
      this.logger.warn({ err, waPhone, externalId }, "Error al consultar estado de mensaje en Zernio");
    }
    return null;
  }

  async sendInteractiveButtons(
    waPhone: string,
    bodyText: string,
    buttons: import("../../application/ports/whatsapp-sender.port").WhatsAppInteractiveButton[],
    headerText?: string,
    footerText?: string,
  ): Promise<{ externalId: string }> {
    const listFormatted = buttons.map((b, idx) => `${idx + 1}️⃣ ${b.title}`).join("\n");
    const fullText = [
      headerText ? `*${headerText}*\n` : "",
      bodyText,
      "\n" + listFormatted,
      "\n_Responde con el número de tu opción (1, 2...)._",
      footerText ? `\n_${footerText}_` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return this.sendText(waPhone, fullText.trim());
  }

  async sendInteractiveList(
    waPhone: string,
    bodyText: string,
    buttonText: string,
    sections: import("../../application/ports/whatsapp-sender.port").WhatsAppInteractiveListSection[],
    headerText?: string,
    footerText?: string,
  ): Promise<{ externalId: string }> {
    const lines: string[] = [];
    if (headerText) lines.push(`*${headerText}*`);
    lines.push(bodyText);
    lines.push("");

    let globalIndex = 1;
    for (const section of sections) {
      if (section.title) lines.push(`*${section.title}*`);
      for (const row of section.rows) {
        const desc = row.description ? ` - ${row.description}` : "";
        lines.push(`${globalIndex}️⃣ ${row.title}${desc}`);
        globalIndex++;
      }
    }

    lines.push(`\n_Por favor responde con el número de la opción (1-${globalIndex - 1}) o selecciónalo._`);
    if (footerText) lines.push(`_${footerText}_`);

    return this.sendText(waPhone, lines.join("\n").trim());
  }
}
