import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import type { Pool } from "pg";
import type Redis from "ioredis";
import { env, type Env } from "../../shared/config/env";
import { createPostgresPool } from "../../shared/db/pool";
import { createRedisClient } from "../../shared/queue/redis";
import { createLogger, type Logger } from "../../shared/logging/logger";
import { createRequestLogger } from "../../shared/http/middlewares/request-logger.middleware";
import { createErrorHandler } from "../../shared/http/middlewares/error-handler.middleware";
import { createHealthRouter } from "../../shared/http/health.router";

import { AuditRepositoryPg } from "../modules/audit/infrastructure/postgres/audit.repository.pg";
import { createAuditRouter } from "../modules/audit/presentation/audit.router";

import { ConversationRepositoryPg } from "../modules/conversations/infrastructure/postgres/conversation.repository.pg";
import { MessageRepositoryPg } from "../modules/conversations/infrastructure/postgres/message.repository.pg";
import { WhatsAppSenderHttp } from "../modules/conversations/infrastructure/whatsapp/whatsapp-sender.http";
import { ReceiveInboundMessageUseCase } from "../modules/conversations/application/use-cases/receive-inbound-message.use-case";
import { ListConversationsUseCase } from "../modules/conversations/application/use-cases/list-conversations.use-case";
import { ListMessagesUseCase } from "../modules/conversations/application/use-cases/list-messages.use-case";
import { ReplyAsHumanUseCase } from "../modules/conversations/application/use-cases/reply-as-human.use-case";
import { createWhatsAppWebhookRouter } from "../modules/conversations/presentation/whatsapp-webhook.router";
import { createConversationsRouter } from "../modules/conversations/presentation/conversations.router";

import { DepartmentRepositoryPg } from "../modules/departments/infrastructure/postgres/department.repository.pg";
import { AgentRepositoryPg } from "../modules/departments/infrastructure/postgres/agent.repository.pg";
import { ListDepartmentsUseCase } from "../modules/departments/application/use-cases/list-departments.use-case";
import { ListAgentsUseCase } from "../modules/departments/application/use-cases/list-agents.use-case";
import { createDepartmentsRouter } from "../modules/departments/presentation/departments.router";

import { InboundBufferService } from "../modules/ingestion/application/services/inbound-buffer.service";

import { CaseRepositoryPg } from "../modules/cases/infrastructure/postgres/case.repository.pg";
import { WorkflowExecutionRepositoryPg } from "../modules/cases/infrastructure/postgres/workflow-execution.repository.pg";
import { N8nWorkflowRegistryRepositoryPg } from "../modules/cases/infrastructure/postgres/n8n-workflow-registry.repository.pg";
import { AiInterpretationAdapter } from "../modules/cases/infrastructure/ai/ai-interpretation.adapter";
import { OllamaAdapter } from "../modules/ai/infrastructure/ollama/ollama-adapter";
import { ComposeCustomerReplyUseCase } from "../modules/ai/application/use-cases/compose-customer-reply.use-case";
import { TranscribeAudioUseCase } from "../modules/ai/application/use-cases/transcribe-audio.use-case";
import { ExtractReceiptDataUseCase } from "../modules/ai/application/use-cases/extract-receipt-data.use-case";
import { N8nGatewayHttp } from "../modules/cases/infrastructure/n8n/n8n-gateway.http";
import { WorkflowEngine } from "../modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../modules/cases/application/engine/definitions/support-internet.workflow";
import { DepartmentResolverService } from "../modules/cases/application/services/department-resolver.service";
import { CaseArbitrationService } from "../modules/cases/application/services/case-arbitration.service";
import { ExpirationService } from "../modules/cases/application/services/expiration.service";
import { N8nWorkflowRegistryCache } from "../modules/cases/application/services/n8n-workflow-registry-cache.service";
import { AdvanceCaseUseCase } from "../modules/cases/application/use-cases/advance-case.use-case";
import { ProcessBufferedMessagesUseCase } from "../modules/cases/application/use-cases/process-buffered-messages.use-case";
import { CancelCaseUseCase } from "../modules/cases/application/use-cases/cancel-case.use-case";
import { ListN8nWorkflowsUseCase } from "../modules/cases/application/use-cases/list-n8n-workflows.use-case";
import { UpsertN8nWorkflowUseCase } from "../modules/cases/application/use-cases/upsert-n8n-workflow.use-case";
import { DeactivateN8nWorkflowUseCase } from "../modules/cases/application/use-cases/deactivate-n8n-workflow.use-case";
import { createN8nWorkflowsRouter } from "../modules/cases/presentation/admin/n8n-workflows.router";
import { createCasesRouter } from "../modules/cases/presentation/cases.router";

import { EscalationRepositoryPg } from "../modules/escalation/infrastructure/postgres/escalation.repository.pg";
import { CaseSummaryBuilderService } from "../modules/escalation/application/services/case-summary-builder.service";
import { EscalationService } from "../modules/escalation/application/services/escalation.service";
import { ClaimCaseUseCase } from "../modules/escalation/application/use-cases/claim-case.use-case";
import { AssignCaseUseCase } from "../modules/escalation/application/use-cases/assign-case.use-case";
import {
  DisableAutomationUseCase,
  ReactivateAutomationUseCase,
} from "../modules/escalation/application/use-cases/disable-automation.use-case";
import {
  GetCaseSummaryUseCase,
  ListEscalationsUseCase,
} from "../modules/escalation/application/use-cases/list-escalations.use-case";
import { createEscalationsRouter } from "../modules/escalation/presentation/escalations.router";

/**
 * Composition root unico del sistema (AGENTS.md - convenciones tecnicas).
 * Aqui, y solo aqui, se instancian adapters de infraestructura y se
 * cablean con los casos de uso/routers de cada modulo.
 * Ningun otro archivo debe construir un Pool/Redis/Router por su cuenta.
 */
export type Container = {
  env: Env;
  app: Express;
  pgPool: Pool;
  redisClient: Redis;
  logger: Logger;
  inboundBuffer: InboundBufferService;
  cancelCase: CancelCaseUseCase;
  expirationService: ExpirationService;
  shutdown: () => Promise<void>;
};

export function createContainer(): Container {
  const logger = createLogger(env);
  const pgPool = createPostgresPool(env);
  const redisClient = createRedisClient(env);

  // Loggers hijos por modulo (AGENTS.md: correlationId end-to-end, cada linea
  // se puede filtrar por `module` ademas de por `correlationId`).
  const conversationsLogger = logger.child({ module: "conversations" });
  const ingestionLogger = logger.child({ module: "ingestion" });
  const casesLogger = logger.child({ module: "cases" });
  const escalationLogger = logger.child({ module: "escalation" });

  // --- Repositorios (infrastructure) ---
  const auditRepo = new AuditRepositoryPg(pgPool);
  const conversationRepo = new ConversationRepositoryPg(pgPool);
  const messageRepo = new MessageRepositoryPg(pgPool);
  const whatsappSender = new WhatsAppSenderHttp(env, conversationsLogger);
  const departmentRepo = new DepartmentRepositoryPg(pgPool);
  const agentRepo = new AgentRepositoryPg(pgPool);
  const caseRepo = new CaseRepositoryPg(pgPool);
  const workflowExecutionRepo = new WorkflowExecutionRepositoryPg(pgPool);
  const n8nWorkflowRegistryRepo = new N8nWorkflowRegistryRepositoryPg(pgPool);
  const escalationRepo = new EscalationRepositoryPg(pgPool);

  // --- Motor de workflow (Etapa 2) ---
  // Unico workflow implementado por ahora (docs/spec/05_BUILD_PLAN.md Etapa 2);
  // BILLING_BALANCE/SALES_PACKAGES se agregan en la Etapa 8 sin tocar el motor.
  const workflowEngine = new WorkflowEngine([supportInternetWorkflow]);
  const departmentResolver = new DepartmentResolverService(departmentRepo);
  const arbitrationService = new CaseArbitrationService(caseRepo, casesLogger);
  const expirationService = new ExpirationService(caseRepo, casesLogger);

  // --- Catalogo de n8n + gateway HTTP real (Etapa 3) ---
  const n8nWorkflowRegistryCache = new N8nWorkflowRegistryCache(n8nWorkflowRegistryRepo);
  const n8nGateway = new N8nGatewayHttp(n8nWorkflowRegistryCache, env.API_INTERNAL_KEY, casesLogger);

  // --- AI (Etapa 5) ---
  const aiLogger = logger.child({ module: "ai" });
  const aiProvider = new OllamaAdapter(
    {
      baseUrl: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL,
      timeoutMs: env.AI_CALL_TIMEOUT_MS,
    },
    aiLogger,
  );
  const interpretationProvider = new AiInterpretationAdapter(aiProvider, aiLogger);
  const composeReply = new ComposeCustomerReplyUseCase(aiProvider);
  const transcribeAudio = new TranscribeAudioUseCase(aiProvider);
  const extractReceiptData = new ExtractReceiptDataUseCase(aiProvider);

  // --- Escalacion / triage (Etapa 6) ---
  const summaryBuilder = new CaseSummaryBuilderService();
  const escalationService = new EscalationService({
    caseRepo,
    escalationRepo,
    workflowExecutionRepo,
    conversationRepo,
    departmentRepo,
    summaryBuilder,
    logger: escalationLogger,
  });
  const claimCase = new ClaimCaseUseCase({
    caseRepo,
    escalationRepo,
    agentRepo,
    departmentRepo,
    auditRepo,
    logger: escalationLogger,
  });
  const assignCase = new AssignCaseUseCase({
    caseRepo,
    escalationRepo,
    agentRepo,
    departmentRepo,
    auditRepo,
    logger: escalationLogger,
  });
  const disableAutomation = new DisableAutomationUseCase({
    caseRepo,
    agentRepo,
    departmentRepo,
    auditRepo,
    logger: escalationLogger,
  });
  const reactivateAutomation = new ReactivateAutomationUseCase({
    caseRepo,
    agentRepo,
    departmentRepo,
    auditRepo,
    logger: escalationLogger,
  });
  const getCaseSummary = new GetCaseSummaryUseCase({
    caseRepo,
    escalationRepo,
    workflowExecutionRepo,
    departmentRepo,
    summaryBuilder,
  });
  const listEscalations = new ListEscalationsUseCase({
    escalationRepo,
    agentRepo,
    departmentRepo,
  });

  // --- Casos de uso (application) ---
  const advanceCase = new AdvanceCaseUseCase({
    caseRepo,
    workflowExecutionRepo,
    conversationRepo,
    engine: workflowEngine,
    gateway: n8nGateway,
    logger: casesLogger,
    escalationService,
  });
  const processBufferedMessages = new ProcessBufferedMessagesUseCase({
    caseRepo,
    conversationRepo,
    messageRepo,
    whatsappSender,
    departmentResolver,
    arbitrationService,
    interpretationProvider,
    engine: workflowEngine,
    advanceCase,
    composeReply,
    transcribeAudio,
    extractReceiptData,
    logger: casesLogger,
    escalationService,
  });
  const cancelCase = new CancelCaseUseCase({ caseRepo, conversationRepo, logger: casesLogger });

  const inboundBuffer = new InboundBufferService(
    redisClient,
    async (conversationId, messageIds) => {
      const batchCorrelationId = randomUUID();
      const messages = await messageRepo.findByIds(messageIds);
      await processBufferedMessages.execute({
        conversationId,
        correlationId: batchCorrelationId,
        messages,
      });
    },
    { debounceMs: env.MESSAGE_DEBOUNCE_MS },
    ingestionLogger,
  );

  const receiveInboundMessage = new ReceiveInboundMessageUseCase({
    conversationRepo,
    messageRepo,
    redisClient,
    inboundBuffer,
    logger: conversationsLogger,
  });
  const listConversations = new ListConversationsUseCase(conversationRepo);
  const listMessages = new ListMessagesUseCase(conversationRepo, messageRepo);
  const replyAsHuman = new ReplyAsHumanUseCase({
    conversationRepo,
    messageRepo,
    whatsappSender,
    auditRepo,
    logger: conversationsLogger,
    caseRepo,
  });
  const listDepartments = new ListDepartmentsUseCase(departmentRepo);
  const listAgents = new ListAgentsUseCase(agentRepo);

  const listN8nWorkflows = new ListN8nWorkflowsUseCase(n8nWorkflowRegistryRepo);
  const upsertN8nWorkflow = new UpsertN8nWorkflowUseCase({
    repo: n8nWorkflowRegistryRepo,
    cache: n8nWorkflowRegistryCache,
    logger: casesLogger,
    defaultTimeoutMs: env.N8N_CALL_TIMEOUT_MS,
    defaultMaxRetries: env.N8N_CALL_MAX_RETRIES,
  });
  const deactivateN8nWorkflow = new DeactivateN8nWorkflowUseCase({
    repo: n8nWorkflowRegistryRepo,
    cache: n8nWorkflowRegistryCache,
    logger: casesLogger,
  });

  // --- HTTP (presentation) ---
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(createRequestLogger(logger));

  app.use(createHealthRouter({ pgPool, redisClient }));
  app.use(createWhatsAppWebhookRouter({ env, receiveInboundMessage, redisClient }));
  app.use(createConversationsRouter({ listConversations, listMessages, replyAsHuman }));
  app.use(createDepartmentsRouter({ listDepartments, listAgents }));
  app.use(createAuditRouter(auditRepo));
  app.use(
    createN8nWorkflowsRouter({
      agentRepo,
      listN8nWorkflows,
      upsertN8nWorkflow,
      deactivateN8nWorkflow,
    }),
  );
  app.use(
    createCasesRouter({
      caseRepo,
      claimCase,
      assignCase,
      disableAutomation,
      reactivateAutomation,
      getCaseSummary,
    }),
  );
  app.use(createEscalationsRouter({ listEscalations }));

  app.use(createErrorHandler(logger));

  const shutdown = async (): Promise<void> => {
    inboundBuffer.clearAllTimers();
    await Promise.all([pgPool.end(), redisClient.quit().catch(() => undefined)]);
  };

  return { env, app, pgPool, redisClient, logger, inboundBuffer, cancelCase, expirationService, shutdown };
}
