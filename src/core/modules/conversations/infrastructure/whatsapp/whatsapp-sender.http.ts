import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import type { WhatsAppSenderPort } from "../../application/ports/whatsapp-sender.port";

const GRAPH_API_VERSION = "v20.0";

type WhatsAppSendResponse = {
  messages?: Array<{ id: string }>;
};

/**
 * Adapter real hacia WhatsApp Business Cloud (docs/spec/00_OVERVIEW.md regla #2).
 * Unica clase del sistema que llama al canal para enviar mensajes.
 */
export class WhatsAppSenderHttp implements WhatsAppSenderPort {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
  ) {}

  async sendText(waPhone: string, body: string): Promise<{ externalId: string }> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const cleanPhone = waPhone.replace(/\D/g, "");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: "text",
        text: { body },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error({ status: response.status, body: errorBody }, "whatsapp Graph API rechazo el envio");
      throw new Error(`WhatsApp send fallo (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as WhatsAppSendResponse;
    const externalId = data.messages?.[0]?.id;
    if (!externalId) {
      this.logger.error({ data }, "respuesta de whatsapp sin id de mensaje");
      throw new Error("Respuesta de WhatsApp sin id de mensaje");
    }

    return { externalId };
  }

  async sendTemplate(
    waPhone: string,
    templateName: string,
    languageCode = "es",
    parameters: string[] = [],
  ): Promise<{ externalId: string }> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const cleanPhone = waPhone.replace(/\D/g, "");

    const components: Array<{ type: string; parameters?: Array<{ type: string; text: string }> }> = [];

    if (parameters.length > 0) {
      components.push({
        type: "body",
        parameters: parameters.map((param) => ({
          type: "text",
          text: param,
        })),
      });
    }

    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length > 0 ? { components } : {}),
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        { status: response.status, body: errorBody, templateName },
        "whatsapp Graph API rechazo el envio de plantilla",
      );
      throw new Error(`WhatsApp sendTemplate fallo (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as WhatsAppSendResponse;
    const externalId = data.messages?.[0]?.id;
    if (!externalId) {
      this.logger.error({ data }, "respuesta de whatsapp sin id de mensaje");
      throw new Error("Respuesta de WhatsApp sin id de mensaje");
    }

    return { externalId };
  }
}
