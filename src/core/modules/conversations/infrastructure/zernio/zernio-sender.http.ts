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
    private readonly fallbackSender?: WhatsAppSenderPort,
  ) {
    this.baseUrl = (this.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1").replace(/\/$/, "");
    if (this.env.ZERNIO_ACCOUNT_ID?.trim()) {
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

  private async getAccountId(forceRefresh = false): Promise<string> {
    if (this.resolvedAccountId && !forceRefresh) {
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

    let response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
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
        url = `${this.baseUrl}/inbox/conversations`;
        payload = {
          accountId,
          participantId: cleanPhone,
          message: body,
        };
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const secondErr = await response.text();
          if (this.fallbackSender) {
            this.logger.warn(
              { cleanPhone, secondErr },
              "Zernio no pudo abrir conversación; entregando directamente vía Meta Cloud API...",
            );
            return this.fallbackSender.sendText(waPhone, body);
          }
          this.logger.error({ status: response.status, body: secondErr }, "Zernio API rechazo el envio tras reintento de conversacion");
          throw new Error(`Zernio sendText fallo (${response.status}): ${secondErr}`);
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
            Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
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
      } else {
        if (this.fallbackSender) {
          this.logger.warn(
            { cleanPhone, status: response.status, errorBody },
            "Zernio API rechazó el envío (ej. TEMPLATE_REQUIRED); entregando directamente vía Meta Cloud API...",
          );
          return this.fallbackSender.sendText(waPhone, body);
        }
        this.logger.error({ status: response.status, body: errorBody }, "Zernio API rechazo el envio de mensaje");
        throw new Error(`Zernio sendText fallo (${response.status}): ${errorBody}`);
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

    let response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
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
            Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
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
        if (this.fallbackSender) {
          this.logger.warn(
            { cleanPhone, templateName, status: response.status, errorBody },
            "Zernio API rechazó la plantilla; entregando vía Meta Cloud API...",
          );
          return this.fallbackSender.sendTemplate(waPhone, templateName, languageCode, parameters);
        }
        this.logger.error({ status: response.status, body: errorBody }, "Zernio API rechazo el envio de plantilla");
        throw new Error(`Zernio sendTemplate fallo (${response.status}): ${errorBody}`);
      }
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
