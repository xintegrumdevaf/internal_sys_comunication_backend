import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ReceiveCrmDomainEventUseCase } from "../../src/core/modules/crm-bridge/application/use-cases/receive-crm-domain-event.use-case";
import { ReceiveCrmOutboundMessageUseCase } from "../../src/core/modules/crm-bridge/application/use-cases/receive-crm-outbound-message.use-case";
import { CrmBridgeHttp } from "../../src/core/modules/crm-bridge/infrastructure/http/crm-bridge.http";
import { createCrmWebhooksRouter } from "../../src/core/modules/crm-bridge/presentation/crm-webhooks.router";
import type { CaseRepositoryPort } from "../../src/core/modules/cases/application/ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../src/core/modules/conversations/application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../src/core/modules/conversations/application/ports/message.repository.port";
import type { WhatsAppSenderPort } from "../../src/core/modules/conversations/application/ports/whatsapp-sender.port";
import type { Env } from "../../src/shared/config/env";
import { signCrmWebhookHeaders, verifyCrmWebhookAuth } from "../../src/shared/http/crm-signature";
import type { Logger } from "../../src/shared/logging/logger";

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => noopLogger,
};

function buildTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    APP_PUBLIC_URL: "http://localhost:3000",
    DATABASE_URL: "postgres://isp:isp@localhost:5432/isp_platform",
    REDIS_URL: "redis://localhost:6379",
    API_INTERNAL_KEY: "isp_internal_key_test",
    CORS_ALLOWED_ORIGINS: "",
    SESSION_TTL_SECONDS: 43200,
    WHATSAPP_APP_SECRET: "",
    WHATSAPP_VERIFY_TOKEN: "",
    WHATSAPP_PHONE_NUMBER_ID: "",
    WHATSAPP_ACCESS_TOKEN: "",
    META_WABA_ID: "",
    META_ACCESS_TOKEN: "",
    WHATSAPP_PROVIDER: "meta",
    ZERNIO_API_KEY: "",
    ZERNIO_ACCOUNT_ID: "",
    ZERNIO_WEBHOOK_SECRET: "",
    ZERNIO_BASE_URL: "https://zernio.com/api/v1",
    AI_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_MODEL: "qwen3.5:4b",
    OLLAMA_EMBEDDING_MODEL: "qwen3-embedding:4b",
    OLLAMA_EMBEDDING_DIMENSION: 2560,
    GEMINI_API_KEY: "",
    GEMINI_MODEL: "gemini-2.5-flash",
    GEMINI_EMBEDDING_MODEL: "gemini-embedding-2",
    GEMINI_EMBEDDING_DIMENSION: 768,
    AI_CALL_TIMEOUT_MS: 45000,
    AI_QUALITY_TIMEOUT_MS: 600000,
    QUALITY_ANALYSIS_CHUNK_SIZE: 40,
    MESSAGE_DEBOUNCE_MS: 4500,
    AUTO_ASSIGN_MAX_ACTIVE_CASES_PER_AGENT: 6,
    MIKROTIK_SERVICE_URL: "http://localhost:3001/api",
    MIKROTIK_DIAGNOSTIC_TIMEOUT_MS: 35000,
    N8N_CALL_TIMEOUT_MS: 8000,
    N8N_CALL_MAX_RETRIES: 2,
    CRM_BACKEND_URL: "http://localhost:4000",
    CRM_WEBHOOK_SECRET: "shared_hmac_secret_stage3_test",
    CRM_INTERNAL_API_KEY: "shared_crm_internal_key_test",
    ...overrides,
  };
}

function buildTestApp() {
  const env = buildTestEnv();
  const now = new Date();
  const conversation = {
    id: "conv-1",
    waPhone: "593991112233",
    waProfileName: "Mariana López",
    customerId: null,
    activeCaseId: "case-sales-1",
    status: "open" as const,
    unreadCount: 0,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const conversationRepo = {
    findById: vi.fn().mockResolvedValue(conversation),
    findByWaPhone: vi.fn().mockResolvedValue(conversation),
    findOrCreateByWaPhone: vi.fn().mockResolvedValue(conversation),
    touchLastActivity: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConversationRepositoryPort;

  const messageRepo = {
    insertOutbound: vi.fn().mockResolvedValue({
      id: "msg-out-1",
      conversationId: "conv-1",
      direction: "outbound",
      author: "agent",
      body: "Hola Mariana",
      type: "text",
      externalId: "wamid.crm.1",
      agentId: null,
      caseId: "case-sales-1",
      mediaId: null,
      mimeType: null,
      caption: null,
      filename: null,
      replyToExternalId: null,
      replyToMessageId: null,
      isForwarded: false,
      status: "sent",
      errorMessage: null,
      createdAt: now,
    }),
  } as unknown as MessageRepositoryPort;

  const whatsappSender = {
    sendText: vi.fn().mockResolvedValue({ externalId: "wamid.crm.1" }),
    sendTemplate: vi.fn(),
  } as unknown as WhatsAppSenderPort;

  const caseRepo = {
    listByConversation: vi.fn().mockResolvedValue([]),
    setAutomationEnabled: vi.fn().mockResolvedValue({
      caseId: "case-sales-1",
      enabled: false,
      disabledReason: "CRM_HUMAN_HANDOFF",
      changedBy: null,
      updatedAt: now,
    }),
    appendEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as CaseRepositoryPort;

  const receiveOutboundMessage = new ReceiveCrmOutboundMessageUseCase({
    conversationRepo,
    messageRepo,
    whatsappSender,
    caseRepo,
    logger: noopLogger,
  });

  const receiveDomainEvent = new ReceiveCrmDomainEventUseCase({
    conversationRepo,
    caseRepo,
    logger: noopLogger,
  });

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(createCrmWebhooksRouter({ env, receiveOutboundMessage, receiveDomainEvent }));

  return { app, env, whatsappSender, messageRepo, caseRepo };
}

describe("CRM Bridge Webhooks & HMAC (Phase 3)", () => {
  it("verifica firma HMAC-SHA256 y rechaza replay expirado", () => {
    const rawBody = JSON.stringify({ eventId: "evt-1", waPhone: "593991112233" });
    const nowSec = String(Math.floor(Date.now() / 1000));
    const headers = signCrmWebhookHeaders({
      rawBody,
      webhookSecret: "secret-123456",
      timestampSec: nowSec,
      idempotencyKey: "evt-1",
    });

    expect(
      verifyCrmWebhookAuth({
        rawBody,
        signatureHeader: headers["x-crm-signature"],
        timestampHeader: headers["x-crm-timestamp"],
        webhookSecret: "secret-123456",
      }),
    ).toBe(true);

    expect(
      verifyCrmWebhookAuth({
        rawBody,
        signatureHeader: headers["x-crm-signature"],
        timestampHeader: String(Math.floor(Date.now() / 1000) - 600),
        webhookSecret: "secret-123456",
      }),
    ).toBe(false);
  });

  it("rechaza POST /api/crm/outbound-message sin firma o clave válida con 401", async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post("/api/crm/outbound-message")
      .send({ toPhone: "593991112233", body: "Hola" });

    expect(res.status).toBe(401);
  });

  it("despacha WhatsApp saliente, pausa bot y deduplica reintentos de Outbox", async () => {
    const { app, env, whatsappSender, caseRepo } = buildTestApp();
    const payload = {
      schemaVersion: "1.0",
      eventId: "out-wa-55",
      eventType: "crm.whatsapp.outbound",
      idempotencyKey: "out-wa-55",
      payload: {
        externalMessageId: "msg-isp-55",
        toPhone: "0991112233",
        body: "Te comparto la cotización de fibra 300 Mbps.",
        actorName: "Laura Méndez",
        pauseBot: true,
      },
    };
    const rawBody = JSON.stringify(payload);
    const headers = signCrmWebhookHeaders({
      rawBody,
      webhookSecret: env.CRM_WEBHOOK_SECRET,
      idempotencyKey: "msg-isp-55",
    });

    const first = await request(app)
      .post("/api/crm/outbound-message")
      .set(headers)
      .send(rawBody);

    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);
    expect(first.body.pausedCaseId).toBe("case-sales-1");
    expect(whatsappSender.sendText).toHaveBeenCalledTimes(1);
    expect(caseRepo.setAutomationEnabled).toHaveBeenCalledWith("case-sales-1", false, {
      reason: "CRM_HUMAN_HANDOFF",
    });

    const retry = await request(app)
      .post("/api/crm/outbound-message")
      .set(headers)
      .send(rawBody);

    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(whatsappSender.sendText).toHaveBeenCalledTimes(1);
  });

  it("sincroniza crm.prospect.assigned y crm.bot.automation_toggled en /api/crm/events/inbound", async () => {
    const { app, env, caseRepo } = buildTestApp();
    const claimedBody = JSON.stringify({
      eventId: "out-assigned-1",
      eventType: "crm.prospect.assigned",
      payload: { phone: "593991112233", agentName: "Carlos Ruiz", automationEnabled: false },
    });
    const claimedHeaders = signCrmWebhookHeaders({
      rawBody: claimedBody,
      webhookSecret: env.CRM_WEBHOOK_SECRET,
    });

    const resClaimed = await request(app)
      .post("/api/crm/events/inbound")
      .set(claimedHeaders)
      .send(claimedBody);

    expect(resClaimed.status).toBe(200);
    expect(resClaimed.body.handled).toBe(true);
    expect(resClaimed.body.automationEnabled).toBe(false);

    const toggledBody = JSON.stringify({
      eventId: "out-toggle-2",
      eventType: "crm.bot.automation_toggled",
      payload: { phone: "593991112233", automationEnabled: true },
    });
    const toggledHeaders = signCrmWebhookHeaders({
      rawBody: toggledBody,
      webhookSecret: env.CRM_WEBHOOK_SECRET,
    });

    const resToggle = await request(app)
      .post("/api/crm/events/inbound")
      .set(toggledHeaders)
      .send(toggledBody);

    expect(resToggle.status).toBe(200);
    expect(resToggle.body.automationEnabled).toBe(true);
    expect(caseRepo.setAutomationEnabled).toHaveBeenLastCalledWith("case-sales-1", true, {
      reason: null,
    });
  });

  it("CrmBridgeHttp retorna no-configurado limpiamente cuando falta CRM_BACKEND_URL", async () => {
    const bridge = new CrmBridgeHttp({
      crmBackendUrl: "",
      logger: noopLogger,
    });
    expect(bridge.isEnabled()).toBe(false);
    const result = await bridge.notifySalesEvent({
      eventId: "evt-noop",
      eventType: "sales.lead.escalated",
      occurredAt: new Date().toISOString(),
      conversationId: "conv-1",
      waPhone: "593991112233",
    });
    expect(result.delivered).toBe(false);
  });

  it("CrmBridgeHttp firma HMAC sobre timestamp.rawBody y envía a /api/v1/crm/integrations/isp/webhook", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ success: true, action: "created" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const bridge = new CrmBridgeHttp({
        crmBackendUrl: "http://localhost:4000",
        webhookSecret: "shared_hmac_secret_stage3_test",
        internalApiKey: "shared_crm_internal_key_test",
        logger: noopLogger,
      });

      const result = await bridge.notifySalesEvent(
        {
          eventId: "isp-case-99",
          eventType: "sales.lead.escalated",
          occurredAt: "2026-11-14T22:50:00.000Z",
          conversationId: "conv-99",
          caseId: "case-99",
          waPhone: "593998887766",
          fullName: "Carlos Mendoza",
          requestedSpeed: "300 Mbps",
          coverage: { hasCoverage: true, zoneName: "Tumbaco Alto", city: "Quito" },
          lastMessageBody: "Quiero contratar el plan de 300 Mbps",
        },
        { correlationId: "corr-99" },
      );

      expect(result.delivered).toBe(true);
      expect(result.status).toBe(201);
      expect(captured).toHaveLength(1);
      const sent = captured[0]!;
      expect(sent.url).toBe("http://localhost:4000/api/v1/crm/integrations/isp/webhook");

      const reqHeaders = sent.init.headers as Record<string, string>;
      const rawBody = String(sent.init.body);
      expect(
        verifyCrmWebhookAuth({
          rawBody,
          signatureHeader: reqHeaders["x-crm-signature"],
          timestampHeader: reqHeaders["x-crm-timestamp"],
          webhookSecret: "shared_hmac_secret_stage3_test",
        }),
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
