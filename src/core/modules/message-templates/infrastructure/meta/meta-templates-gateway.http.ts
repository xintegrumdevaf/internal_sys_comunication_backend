import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import type { MessageTemplateStatus } from "../../domain/message-template.entity";
import type {
  FetchTemplateStatusResult,
  MetaTemplatesGatewayPort,
  SubmitTemplateInput,
  SubmitTemplateResult,
} from "../../application/ports/meta-templates-gateway.port";

const GRAPH_API_VERSION = "v20.0";

type MetaSubmitResponse = {
  id?: string;
  status?: string;
  error?: {
    message: string;
    type: string;
    code: number;
  };
};

type MetaFetchResponse = {
  id?: string;
  status?: string;
  rejected_reason?: string;
  reason?: string;
};

export class MetaTemplatesGatewayHttp implements MetaTemplatesGatewayPort {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
  ) {}

  private get accessToken(): string {
    return this.env.META_ACCESS_TOKEN || this.env.WHATSAPP_ACCESS_TOKEN;
  }

  private get wabaId(): string {
    const id = this.env.META_WABA_ID?.trim();
    if (!id) {
      throw new Error(
        "Falta configurar META_WABA_ID en las variables de entorno (.env). La API de Meta exige el WABA ID (WhatsApp Business Account ID), no el Phone Number ID, para la gestión de plantillas de mensaje.",
      );
    }
    return id;
  }

  async submitTemplate(template: SubmitTemplateInput): Promise<SubmitTemplateResult> {
    const components: Array<Record<string, unknown>> = [];

    if (template.headerType && template.headerType !== "NONE") {
      const headerComp: Record<string, unknown> = {
        type: "HEADER",
        format: template.headerType,
      };
      if (template.headerType === "TEXT" && template.headerContent) {
        headerComp.text = template.headerContent;
      }
      components.push(headerComp);
    }

    const varMatches = template.bodyText.match(/\{\{(\d+)\}\}/g);
    const bodyComp: Record<string, unknown> = {
      type: "BODY",
      text: template.bodyText,
    };

    if (varMatches && varMatches.length > 0) {
      let maxVarIndex = 0;
      for (const m of varMatches) {
        const num = parseInt(m.replace(/\D/g, ""), 10);
        if (!isNaN(num) && num > maxVarIndex) maxVarIndex = num;
      }
      if (maxVarIndex > 0) {
        const samples = Array.from({ length: maxVarIndex }, (_, i) => `ejemplo_${i + 1}`);
        bodyComp.example = {
          body_text: [samples],
        };
      }
    }

    components.push(bodyComp);

    if (template.footerText) {
      components.push({
        type: "FOOTER",
        text: template.footerText,
      });
    }

    if (template.buttons && template.buttons.length > 0) {
      components.push({
        type: "BUTTONS",
        buttons: template.buttons.map((btn) => {
          if (btn.type === "URL") {
            return { type: "URL", text: btn.text, url: btn.url };
          }
          if (btn.type === "PHONE_NUMBER") {
            return { type: "PHONE_NUMBER", text: btn.text, phone_number: btn.phoneNumber };
          }
          return { type: "QUICK_REPLY", text: btn.text };
        }),
      });
    }

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.wabaId}/message_templates`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          name: template.name,
          category: template.category,
          language: template.language,
          components,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error({ status: response.status, body: errorText }, "Meta API rechazo la creacion de plantilla");
        throw new Error(`Meta Graph API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as MetaSubmitResponse;
      if (!data.id) {
        throw new Error("Respuesta de Meta Graph API sin ID de plantilla");
      }

      const status: MessageTemplateStatus = (data.status as MessageTemplateStatus) || "PENDING";
      return {
        metaTemplateId: data.id,
        status,
      };
    } catch (error) {
      this.logger.error({ err: error, templateName: template.name }, "Fallo al enviar plantilla a Meta API");
      throw error;
    }
  }

  async fetchTemplateStatus(metaTemplateId: string): Promise<FetchTemplateStatusResult> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${metaTemplateId}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error({ status: response.status, metaTemplateId }, "Meta API rechazo la consulta de estado");
      throw new Error(`Meta Graph API fetch error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as MetaFetchResponse;
    const status: MessageTemplateStatus = (data.status as MessageTemplateStatus) || "PENDING";
    const rejectedReason = data.rejected_reason || data.reason || null;

    return {
      metaTemplateId,
      status,
      rejectedReason,
    };
  }

  async deleteTemplate(metaTemplateId: string, name: string): Promise<boolean> {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${this.wabaId}/message_templates?hsm_id=${metaTemplateId}&name=${encodeURIComponent(
      name,
    )}`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.warn({ status: response.status, name, metaTemplateId }, "Meta API advertencia al eliminar plantilla");
      // Retornamos true si responde success o si la plantilla no existe
      return false;
    }

    const data = (await response.json()) as { success?: boolean };
    return data.success ?? true;
  }
}
