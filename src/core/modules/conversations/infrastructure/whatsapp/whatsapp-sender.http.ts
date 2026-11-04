import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import type {
  SendWhatsAppMediaInput,
  SendWhatsAppMediaOutput,
  WhatsAppSenderPort,
} from "../../application/ports/whatsapp-sender.port";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";

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
    private readonly settingsService?: SystemSettingsService,
  ) {}

  private async resolveCredentials(): Promise<{ phoneNumberId: string; accessToken: string }> {
    let phoneNumberId = this.env.WHATSAPP_PHONE_NUMBER_ID || "";
    let accessToken = this.env.WHATSAPP_ACCESS_TOKEN || "";
    if (this.settingsService) {
      try {
        const config = await this.settingsService.getChannelSettings();
        if (config.phoneNumberId) phoneNumberId = config.phoneNumberId;
        if (config.accessToken) accessToken = config.accessToken;
      } catch {
        // Fallback a env
      }
    }
    return { phoneNumberId, accessToken };
  }

  async sendText(waPhone: string, body: string): Promise<{ externalId: string }> {
    const creds = await this.resolveCredentials();
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.phoneNumberId}/messages`;

    const cleanPhone = waPhone.replace(/\D/g, "");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.accessToken}`,
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

  async sendMedia(input: SendWhatsAppMediaInput): Promise<SendWhatsAppMediaOutput> {
    const creds = await this.resolveCredentials();
    const cleanPhone = input.waPhone.replace(/\D/g, "");
    let uploadedMediaId: string | undefined;

    if (input.buffer && input.buffer.length > 0) {
      const uploadUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.phoneNumberId}/media`;
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", input.mimeType || "application/octet-stream");
      const filename = input.filename || `adjunto.${input.type === "image" ? "jpg" : input.type === "video" ? "mp4" : input.type === "audio" ? "ogg" : "pdf"}`;
      const blob = new Blob([new Uint8Array(input.buffer)], {
        type: input.mimeType || "application/octet-stream",
      });
      form.append("file", blob, filename);

      const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
        },
        body: form,
      });

      if (!uploadRes.ok) {
        const errorBody = await uploadRes.text();
        this.logger.error(
          { status: uploadRes.status, body: errorBody, type: input.type, mimeType: input.mimeType },
          "whatsapp Graph API rechazo la subida de archivo multimedia",
        );
        throw new Error(`WhatsApp media upload fallo (${uploadRes.status}): ${errorBody}`);
      }

      const uploadData = (await uploadRes.json()) as { id?: string };
      if (!uploadData.id) {
        throw new Error("Respuesta de subida de media de WhatsApp sin id");
      }
      uploadedMediaId = uploadData.id;
    } else if (!input.mediaUrl) {
      throw new Error("Se requiere un archivo binario o una URL pública para enviar multimedia por WhatsApp");
    }

    const sendUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.phoneNumberId}/messages`;
    const mediaPayload: Record<string, unknown> = uploadedMediaId
      ? { id: uploadedMediaId }
      : { link: input.mediaUrl };

    if (input.caption && input.type !== "audio") {
      mediaPayload.caption = input.caption;
    }
    if (input.type === "document" && input.filename) {
      mediaPayload.filename = input.filename;
    }

    const response = await fetch(sendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: input.type,
        [input.type]: mediaPayload,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        { status: response.status, body: errorBody, type: input.type },
        "whatsapp Graph API rechazo el envio de mensaje multimedia",
      );
      throw new Error(`WhatsApp sendMedia fallo (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as WhatsAppSendResponse;
    const externalId = data.messages?.[0]?.id;
    if (!externalId) {
      this.logger.error({ data }, "respuesta de whatsapp sendMedia sin id de mensaje");
      throw new Error("Respuesta de WhatsApp sin id de mensaje");
    }

    return {
      externalId,
      remoteMediaId: uploadedMediaId ?? input.mediaUrl,
    };
  }

  async sendTemplate(
    waPhone: string,
    templateName: string,
    languageCode = "es",
    parameters: string[] = [],
  ): Promise<{ externalId: string }> {
    const creds = await this.resolveCredentials();
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.phoneNumberId}/messages`;

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
        Authorization: `Bearer ${creds.accessToken}`,
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

  async sendInteractiveButtons(
    waPhone: string,
    bodyText: string,
    buttons: import("../../application/ports/whatsapp-sender.port").WhatsAppInteractiveButton[],
    headerText?: string,
    footerText?: string,
  ): Promise<{ externalId: string }> {
    const creds = await this.resolveCredentials();
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.phoneNumberId}/messages`;
    const cleanPhone = waPhone.replace(/\D/g, "");

    const payload = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "interactive",
      interactive: {
        type: "button",
        ...(headerText ? { header: { type: "text", text: headerText } } : {}),
        body: { text: bodyText.slice(0, 1024) },
        ...(footerText ? { footer: { text: footerText.slice(0, 60) } } : {}),
        action: {
          buttons: (() => {
            const seen = new Set<string>();
            return buttons.slice(0, 3).map((b, i) => {
              let title = b.title.trim().slice(0, 20);
              if (!title) title = `Opción ${i + 1}`;
              if (seen.has(title)) {
                title = `${i + 1}. ${title}`.slice(0, 20);
              }
              if (seen.has(title)) {
                title = `Opción ${i + 1}`;
              }
              seen.add(title);
              return {
                type: "reply" as const,
                reply: {
                  id: b.id.slice(0, 256),
                  title,
                },
              };
            });
          })(),
        },
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error({ status: response.status, body: errorBody }, "whatsapp Graph API rechazo el envio de botones interactivos");
      throw new Error(`WhatsApp sendInteractiveButtons fallo (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as WhatsAppSendResponse;
    const externalId = data.messages?.[0]?.id;
    if (!externalId) {
      throw new Error("Respuesta de WhatsApp sin id de mensaje");
    }
    return { externalId };
  }

  async sendInteractiveList(
    waPhone: string,
    bodyText: string,
    buttonText: string,
    sections: import("../../application/ports/whatsapp-sender.port").WhatsAppInteractiveListSection[],
    headerText?: string,
    footerText?: string,
  ): Promise<{ externalId: string }> {
    const creds = await this.resolveCredentials();
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${creds.phoneNumberId}/messages`;
    const cleanPhone = waPhone.replace(/\D/g, "");

    const payload = {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "interactive",
      interactive: {
        type: "list",
        ...(headerText ? { header: { type: "text", text: headerText } } : {}),
        body: { text: bodyText.slice(0, 1024) },
        ...(footerText ? { footer: { text: footerText.slice(0, 60) } } : {}),
        action: {
          button: buttonText.slice(0, 20),
          sections: sections.map((s) => ({
            title: (s.title || "Opciones").slice(0, 24),
            rows: s.rows.slice(0, 10).map((r) => ({
              id: r.id.slice(0, 200),
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error({ status: response.status, body: errorBody }, "whatsapp Graph API rechazo el envio de lista interactiva");
      throw new Error(`WhatsApp sendInteractiveList fallo (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as WhatsAppSendResponse;
    const externalId = data.messages?.[0]?.id;
    if (!externalId) {
      throw new Error("Respuesta de WhatsApp sin id de mensaje");
    }
    return { externalId };
  }
}
