import type { Logger } from "../../../../../shared/logging/logger";
import { signCrmWebhookHeaders } from "../../../../../shared/http/crm-signature";
import type {
  CrmBridgeDeliveryResult,
  CrmBridgePort,
  CrmSalesWebhookEvent,
} from "../../application/ports/crm-bridge.port";

export interface CrmBridgeHttpConfig {
  crmBackendUrl: string;
  webhookSecret?: string;
  internalApiKey?: string;
  timeoutMs?: number;
  logger: Logger;
}

/**
 * HTTP adapter implementing CrmBridgePort with HMAC-SHA256 signing and bounded timeouts.
 */
export class CrmBridgeHttp implements CrmBridgePort {
  private readonly targetUrl: string | null;
  private readonly webhookSecret?: string;
  private readonly internalApiKey?: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(config: CrmBridgeHttpConfig) {
    const base = (config.crmBackendUrl || "").trim().replace(/\/$/, "");
    this.targetUrl = base ? `${base}/api/v1/crm/integrations/isp/webhook` : null;
    this.webhookSecret = config.webhookSecret;
    this.internalApiKey = config.internalApiKey;
    this.timeoutMs = config.timeoutMs ?? 4000;
    this.logger = config.logger;
  }

  isEnabled(): boolean {
    return Boolean(this.targetUrl);
  }

  async notifySalesEvent(
    event: CrmSalesWebhookEvent,
    options?: { correlationId?: string },
  ): Promise<CrmBridgeDeliveryResult> {
    if (!this.targetUrl) {
      return { delivered: false, error: "CRM_BACKEND_URL no configurado" };
    }

    const log = options?.correlationId
      ? this.logger.child({
          correlationId: options.correlationId,
          eventId: event.eventId,
          eventType: event.eventType,
        })
      : this.logger.child({ eventId: event.eventId, eventType: event.eventType });

    const rawBody = JSON.stringify(event);
    const headers = signCrmWebhookHeaders({
      rawBody,
      webhookSecret: this.webhookSecret,
      internalApiKey: this.internalApiKey,
      idempotencyKey: event.eventId,
    });

    try {
      const response = await fetch(this.targetUrl, {
        method: "POST",
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        log.info({ status: response.status, waPhone: event.waPhone }, "evento comercial entregado al CRM");
        return { delivered: true, status: response.status };
      }

      const errorText = `CRM HTTP ${response.status}`;
      log.warn({ status: response.status, waPhone: event.waPhone }, "el CRM rechazó webhook comercial");
      return { delivered: false, status: response.status, error: errorText };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg, waPhone: event.waPhone }, "error de red enviando evento al CRM");
      return { delivered: false, error: msg };
    }
  }
}
