import { Router, type Request } from "express";
import type { Env } from "../../../../shared/config/env";
import { verifyCrmWebhookAuth } from "../../../../shared/http/crm-signature";
import type { ReceiveCrmDomainEventUseCase } from "../application/use-cases/receive-crm-domain-event.use-case";
import type { ReceiveCrmOutboundMessageUseCase } from "../application/use-cases/receive-crm-outbound-message.use-case";
import {
  registerCrmConversationsBridgeRoutes,
  type CrmConversationsBridgeDeps,
} from "./crm-conversations-bridge.router";

export interface CrmWebhooksRouterDeps extends CrmConversationsBridgeDeps {
  env: Env;
  receiveOutboundMessage: ReceiveCrmOutboundMessageUseCase;
  receiveDomainEvent: ReceiveCrmDomainEventUseCase;
}

function isAuthorizedCrmRequest(req: Request, env: Env): boolean {
  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body ?? {});
  return verifyCrmWebhookAuth({
    rawBody,
    signatureHeader: req.header("x-crm-signature") ?? undefined,
    timestampHeader: req.header("x-crm-timestamp") ?? undefined,
    internalKeyHeader: req.header("x-api-internal-key") ?? undefined,
    webhookSecret: env.CRM_WEBHOOK_SECRET ?? "",
    expectedInternalKeys: [env.CRM_INTERNAL_API_KEY ?? "", env.API_INTERNAL_KEY],
  });
}

/**
 * HTTP webhooks invoked by CRM_sys_backend (mounted before session auth,
 * authenticated strictly by HMAC-SHA256 signature or internal API key).
 */
export function createCrmWebhooksRouter(deps: CrmWebhooksRouterDeps): Router {
  const router = Router();
  const { env, receiveOutboundMessage, receiveDomainEvent } = deps;

  router.post("/api/crm/outbound-message", async (req, res, next) => {
    try {
      if (!isAuthorizedCrmRequest(req, env)) {
        req.log?.warn({ path: req.path }, "webhook CRM saliente rechazado por autenticación");
        res.status(401).json({
          error: {
            code: "UNAUTHORIZED",
            message: "Firma HMAC X-Crm-Signature o clave interna inválida",
          },
        });
        return;
      }

      const result = await receiveOutboundMessage.execute(req.body ?? {});
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/crm/events/inbound", async (req, res, next) => {
    try {
      if (!isAuthorizedCrmRequest(req, env)) {
        req.log?.warn({ path: req.path }, "evento CRM inbound rechazado por autenticación");
        res.status(401).json({
          error: {
            code: "UNAUTHORIZED",
            message: "Firma HMAC X-Crm-Signature o clave interna inválida",
          },
        });
        return;
      }

      const result = await receiveDomainEvent.execute(req.body ?? {});
      res.status(200).json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  registerCrmConversationsBridgeRoutes(router, env, isAuthorizedCrmRequest, deps);

  return router;
}
