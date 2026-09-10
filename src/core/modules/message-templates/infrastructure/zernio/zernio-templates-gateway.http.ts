import { externalServiceError, validationError } from "../../../../../shared/errors/domain-errors";
import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import type { MessageTemplateStatus } from "../../domain/message-template.entity";
import type {
  FetchTemplateStatusResult,
  MetaTemplatesGatewayPort,
  SubmitTemplateInput,
  SubmitTemplateResult,
} from "../../application/ports/meta-templates-gateway.port";

type ZernioTemplateResponse = {
  success?: boolean;
  template?: {
    id?: string;
    name?: string;
    status?: string;
    rejected_reason?: string;
  };
  error?: string;
  message?: string;
};

export class ZernioTemplatesGatewayHttp implements MetaTemplatesGatewayPort {
  private resolvedAccountId: string | null = null;
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
      throw externalServiceError(`Zernio accounts lookup fallo (${res.status}): ${errText}`);
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
      throw validationError(
        `No se encontro ninguna cuenta de WhatsApp en Zernio para el identificador: ${inputId || "(vacio)"}`,
      );
    }

    this.resolvedAccountId = matched._id;
    return this.resolvedAccountId;
  }

  async submitTemplate(template: SubmitTemplateInput): Promise<SubmitTemplateResult> {
    const accountId = await this.getAccountId();
    const components: Array<Record<string, unknown>> = [];

    if (template.headerType && template.headerType !== "NONE") {
      const headerComp: Record<string, unknown> = {
        type: "header",
        format: template.headerType.toLowerCase(),
      };
      if (template.headerType === "TEXT" && template.headerContent) {
        headerComp.text = template.headerContent;
      }
      components.push(headerComp);
    }

    const varMatches = template.bodyText.match(/\{\{(\d+)\}\}/g);
    const bodyComp: Record<string, unknown> = {
      type: "body",
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
        type: "footer",
        text: template.footerText,
      });
    }

    if (template.buttons && template.buttons.length > 0) {
      components.push({
        type: "buttons",
        buttons: template.buttons.map((btn) => {
          if (btn.type === "URL") {
            return { type: "url", text: btn.text, url: btn.url };
          }
          if (btn.type === "PHONE_NUMBER") {
            return { type: "phone_number", text: btn.text, phone_number: btn.phoneNumber };
          }
          return { type: "quick_reply", text: btn.text };
        }),
      });
    }

    const url = `${this.baseUrl}/whatsapp/templates`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
        },
        body: JSON.stringify({
          accountId,
          name: template.name,
          category: template.category,
          language: template.language,
          components,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error({ status: response.status, body: errorText }, "Zernio API rechazo la creacion de plantilla");
        throw externalServiceError(`Zernio plantilla rechazada (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as ZernioTemplateResponse;
      const metaTemplateId = data.template?.id;
      if (!metaTemplateId) {
        throw externalServiceError("Respuesta de Zernio API sin ID de plantilla");
      }

      const status: MessageTemplateStatus = (data.template?.status as MessageTemplateStatus) || "PENDING";

      return {
        metaTemplateId,
        status,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AppError") throw error;
      throw externalServiceError(error instanceof Error ? error.message : "Error al conectar con Zernio Templates API");
    }
  }

  async fetchTemplateStatus(metaTemplateId: string): Promise<FetchTemplateStatusResult> {
    const accountId = await this.getAccountId();
    const url = `${this.baseUrl}/whatsapp/templates/id/${encodeURIComponent(metaTemplateId)}?accountId=${encodeURIComponent(accountId)}`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw externalServiceError(`Error al consultar plantilla en Zernio (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as ZernioTemplateResponse;
      const tpl = data.template;
      if (!tpl?.id) {
        throw externalServiceError("Zernio no devolvio el objeto de plantilla");
      }

      const status: MessageTemplateStatus = (tpl.status as MessageTemplateStatus) || "PENDING";
      const rejectedReason = tpl.rejected_reason || null;

      return {
        metaTemplateId: tpl.id,
        status,
        rejectedReason,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AppError") throw error;
      throw externalServiceError(error instanceof Error ? error.message : "Error al consultar estado en Zernio");
    }
  }

  async deleteTemplate(metaTemplateId: string, _name: string): Promise<boolean> {
    const accountId = await this.getAccountId();
    const url = `${this.baseUrl}/whatsapp/templates/id/${encodeURIComponent(metaTemplateId)}?accountId=${encodeURIComponent(accountId)}`;

    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error({ status: response.status, body: errorText }, "Error al eliminar plantilla en Zernio");
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error({ err: error }, "Fallo de red al eliminar plantilla en Zernio");
      return false;
    }
  }
}
