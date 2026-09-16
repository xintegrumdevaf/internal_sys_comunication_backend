import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import type { WhatsAppSenderPort } from "../../application/ports/whatsapp-sender.port";

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
  id: string;
  accountId: string;
  participantId: string;
  participantUsername?: string;
};

/**
 * Adapter para envío de mensajes vía API de Zernio (docs/spec/00_OVERVIEW.md regla #2).
 * Implementa WhatsAppSenderPort desacoplado de la API nativa de Meta.
 */
export class ZernioSenderHttp implements WhatsAppSenderPort {
  private resolvedAccountId: string | null = null;
  private readonly conversationIdCache = new Map<string, string>();
  private readonly phoneByConversationIdCache = new Map<string, string>();
  private readonly baseUrl: string;

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
  ) {
    this.baseUrl = (this.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1").replace(/\/$/, "");
    if (this.env.ZERNIO_ACCOUNT_ID && /^[a-f\d]{24}$/i.test(this.env.ZERNIO_ACCOUNT_ID.trim())) {
      this.resolvedAccountId = this.env.ZERNIO_ACCOUNT_ID.trim();
    }
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
   * Guarda o actualiza la asociación de un teléfono con su ID de conversación en Zernio.
   * Utilizado también desde el webhook entrante para enriquecer el cache.
   */
  public registerConversation(waPhone: string, conversationId: string): void {
    const cleanPhone = waPhone.replace(/\D/g, "");
    if (cleanPhone && conversationId && !this.isBusinessAccount(cleanPhone)) {
      this.conversationIdCache.set(cleanPhone, conversationId);
      this.phoneByConversationIdCache.set(conversationId, cleanPhone);
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

    try {
      const url = `${this.baseUrl}/inbox/conversations?platform=whatsapp`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
        },
      });

      if (res.ok) {
        const data = (await res.json()) as { data?: ZernioConversationItem[] };
        for (const item of data.data || []) {
          const participant = (item.participantId || item.participantUsername || "").replace(/\D/g, "");
          if (participant && !this.isBusinessAccount(participant)) {
            this.conversationIdCache.set(participant, item.id);
            this.phoneByConversationIdCache.set(item.id, participant);
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "No se pudo resolver el teléfono desde Zernio por conversationId");
    }

    return this.phoneByConversationIdCache.get(conversationId) || null;
  }

  private async getAccountId(): Promise<string> {
    if (this.resolvedAccountId) {
      return this.resolvedAccountId;
    }

    const inputId = this.env.ZERNIO_ACCOUNT_ID?.trim();
    const url = `${this.baseUrl}/accounts`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
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

  private async resolveConversationId(cleanPhone: string): Promise<string | null> {
    if (this.conversationIdCache.has(cleanPhone)) {
      return this.conversationIdCache.get(cleanPhone)!;
    }

    try {
      const url = `${this.baseUrl}/inbox/conversations?platform=whatsapp`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
        },
      });

      if (res.ok) {
        const data = (await res.json()) as { data?: ZernioConversationItem[] };
        for (const item of data.data || []) {
          const participant = (item.participantId || item.participantUsername || "").replace(/\D/g, "");
          if (participant) {
            this.conversationIdCache.set(participant, item.id);
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "No se pudo sincronizar cache de conversaciones de Zernio");
    }

    return this.conversationIdCache.get(cleanPhone) || null;
  }

  async sendText(waPhone: string, body: string): Promise<{ externalId: string }> {
    const cleanPhone = waPhone.replace(/\D/g, "");
    const accountId = await this.getAccountId();
    const existingConversationId = await this.resolveConversationId(cleanPhone);

    let url: string;
    let payload: Record<string, unknown>;

    if (existingConversationId) {
      url = `${this.baseUrl}/inbox/conversations/${existingConversationId}/messages`;
      payload = {
        accountId,
        message: body,
      };
    } else {
      url = `${this.baseUrl}/inbox/conversations`;
      payload = {
        accountId,
        participantId: cleanPhone,
        message: body,
      };
    }

    this.logger.info({ waPhone: cleanPhone, hasExistingConv: !!existingConversationId }, "Enviando texto via Zernio");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error({ status: response.status, body: errorBody }, "Zernio API rechazo el envio de mensaje");
      throw new Error(`Zernio sendText fallo (${response.status}): ${errorBody}`);
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
      this.conversationIdCache.set(cleanPhone, data.data.conversationId);
    }

    return { externalId };
  }

  async sendTemplate(
    waPhone: string,
    templateName: string,
    languageCode = "es",
    parameters: string[] = [],
  ): Promise<{ externalId: string }> {
    const cleanPhone = waPhone.replace(/\D/g, "");
    const accountId = await this.getAccountId();

    const url = `${this.baseUrl}/inbox/conversations`;
    const payload: Record<string, unknown> = {
      accountId,
      participantId: cleanPhone,
      templateName,
      templateLanguage: languageCode,
    };

    if (parameters.length > 0) {
      payload.templateParams = parameters;
    }

    this.logger.info({ waPhone: cleanPhone, templateName }, "Enviando plantilla via Zernio");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error({ status: response.status, body: errorBody }, "Zernio API rechazo el envio de plantilla");
      throw new Error(`Zernio sendTemplate fallo (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as ZernioMessageResponse;
    const externalId =
      data.data?.messageId ||
      data.platformMessageId ||
      data.messageId ||
      data.id ||
      `zernio-tpl-${Date.now()}`;

    return { externalId };
  }

  async checkMessageStatus(
    waPhone: string,
    externalId: string,
  ): Promise<{ status: "sent" | "delivered" | "failed"; errorMessage?: string } | null> {
    try {
      const cleanPhone = waPhone.replace(/\D/g, "");
      const accountId = await this.getAccountId();
      const convId = await this.resolveConversationId(cleanPhone);
      if (!convId) return null;

      const url = `${this.baseUrl}/inbox/conversations/${convId}/messages?accountId=${accountId}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
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
          const errDetail =
            matched.deliveryError?.details ||
            matched.deliveryError?.message ||
            matched.deliveryError?.title ||
            "Error de entrega en Meta / WhatsApp";
          const errCode = matched.deliveryError?.code ? ` (Meta Error ${matched.deliveryError.code})` : "";
          return { status: "failed", errorMessage: `${errDetail}${errCode}` };
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
}
