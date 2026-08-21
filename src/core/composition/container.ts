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
import { createCors } from "../../shared/http/middlewares/cors.middleware";
import { createHealthRouter } from "../../shared/http/health.router";

import { AuditRepositoryPg } from "../modules/audit/infrastructure/postgres/audit.repository.pg";
import { createAuditRouter } from "../modules/audit/presentation/audit.router";

import { ConversationRepositoryPg } from "../modules/conversations/infrastructure/postgres/conversation.repository.pg";
import { MessageRepositoryPg } from "../modules/conversations/infrastructure/postgres/message.repository.pg";
import { WhatsAppSenderHttp } from "../modules/conversations/infrastructure/whatsapp/whatsapp-sender.http";
import { ReceiveInboundMessageUseCase } from "../modules/conversations/application/use-cases/receive-inbound-message.use-case";
import { ListConversationsUseCase } from "../modules/conversations/application/use-cases/list-conversations.use-case";
import { ListMessagesUseCase } from "../modules/conversations/application/use-cases/list-messages.use-case";
import { MarkConversationAsReadUseCase } from "../modules/conversations/application/use-cases/mark-conversation-as-read.use-case";
import { ReplyAsHumanUseCase } from "../modules/conversations/application/use-cases/reply-as-human.use-case";
import { createWhatsAppWebhookRouter } from "../modules/conversations/presentation/whatsapp-webhook.router";
import { createConversationsRouter } from "../modules/conversations/presentation/conversations.router";

import { CustomerRepositoryPg } from "../modules/customers/infrastructure/postgres/customer.repository.pg";
import { ContractRepositoryPg } from "../modules/customers/infrastructure/postgres/contract.repository.pg";
import { ConversationIdentityService } from "../modules/customers/application/services/conversation-identity.service";

import { DepartmentRepositoryPg } from "../modules/departments/infrastructure/postgres/department.repository.pg";
import { AgentRepositoryPg } from "../modules/departments/infrastructure/postgres/agent.repository.pg";
import { ListDepartmentsUseCase } from "../modules/departments/application/use-cases/list-departments.use-case";
import { ListAgentsUseCase } from "../modules/departments/application/use-cases/list-agents.use-case";
import { CreateAgentUseCase } from "../modules/departments/application/use-cases/create-agent.use-case";
import { UpdateAgentUseCase } from "../modules/departments/application/use-cases/update-agent.use-case";
import { DeactivateAgentUseCase } from "../modules/departments/application/use-cases/deactivate-agent.use-case";
import { ResetAgentPasswordUseCase } from "../modules/departments/application/use-cases/reset-agent-password.use-case";
import { createDepartmentsRouter } from "../modules/departments/presentation/departments.router";
import { createAgentsAdminRouter } from "../modules/departments/presentation/admin/agents.router";
import { CreateDepartmentUseCase } from "../modules/departments/application/use-cases/create-department.use-case";
import { UpdateDepartmentUseCase } from "../modules/departments/application/use-cases/update-department.use-case";
import { DeactivateDepartmentUseCase } from "../modules/departments/application/use-cases/deactivate-department.use-case";
import { createDepartmentsAdminRouter } from "../modules/departments/presentation/admin/departments.router";

import { SessionStoreRedis } from "../modules/auth/infrastructure/redis/session-store.repository.redis";
import { LoginUseCase } from "../modules/auth/application/use-cases/login.use-case";
import { LogoutUseCase } from "../modules/auth/application/use-cases/logout.use-case";
import { ChangePasswordUseCase } from "../modules/auth/application/use-cases/change-password.use-case";
import { createSessionMiddleware } from "../modules/auth/presentation/session.middleware";
import { createAuthRouter } from "../modules/auth/presentation/auth.router";

import { InboundBufferService } from "../modules/ingestion/application/services/inbound-buffer.service";

import { CaseRepositoryPg } from "../modules/cases/infrastructure/postgres/case.repository.pg";
import { WorkflowExecutionRepositoryPg } from "../modules/cases/infrastructure/postgres/workflow-execution.repository.pg";
import { N8nWorkflowRegistryRepositoryPg } from "../modules/cases/infrastructure/postgres/n8n-workflow-registry.repository.pg";
import { AiInterpretationAdapter } from "../modules/cases/infrastructure/ai/ai-interpretation.adapter";
import { OllamaAdapter } from "../modules/ai/infrastructure/ollama/ollama-adapter";
import { GeminiAdapter } from "../modules/ai/infrastructure/gemini/gemini-adapter";
import { AIProviderPort } from "../modules/ai/application/ports/ai-provider.port";
import { ComposeCustomerReplyUseCase } from "../modules/ai/application/use-cases/compose-customer-reply.use-case";
import { TranscribeAudioUseCase } from "../modules/ai/application/use-cases/transcribe-audio.use-case";
import { ExtractReceiptDataUseCase } from "../modules/ai/application/use-cases/extract-receipt-data.use-case";
import { N8nGatewayHttp } from "../modules/cases/infrastructure/n8n/n8n-gateway.http";
import { WorkflowEngine } from "../modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../modules/cases/application/engine/definitions/support-internet.workflow";
import { billingBalanceWorkflow } from "../modules/cases/application/engine/definitions/billing-balance.workflow";
import { salesPackagesWorkflow } from "../modules/cases/application/engine/definitions/sales-packages.workflow";
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
import { AutoAssignAgentService } from "../modules/escalation/application/services/auto-assign-agent.service";
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
import { RealtimeBroadcaster } from "../modules/realtime/application/realtime-broadcaster";
import { createRealtimeRouter } from "../modules/realtime/presentation/realtime.router";
import { CompleteCaseUseCase } from "../modules/cases/application/use-cases/complete-case.use-case";
import { TransferCaseUseCase } from "../modules/cases/application/use-cases/transfer-case.use-case";
import { GetDashboardUseCase } from "../modules/cases/application/use-cases/get-dashboard.use-case";
import { TakeControlUseCase } from "../modules/conversations/application/use-cases/take-control.use-case";

import { QualityReviewRepositoryPg } from "../modules/quality/infrastructure/postgres/quality-review.repository.pg";
import { EnqueueQualityReviewService } from "../modules/quality/application/services/enqueue-quality-review.service";
import { RunQualityAnalysisUseCase } from "../modules/quality/application/use-cases/run-quality-analysis.use-case";
import { RequestOnDemandReviewUseCase } from "../modules/quality/application/use-cases/request-on-demand-review.use-case";
import { ListQualityReviewsUseCase } from "../modules/quality/application/use-cases/list-quality-reviews.use-case";
import { GetQualityReviewUseCase } from "../modules/quality/application/use-cases/get-quality-review.use-case";
import { GetAgentQualityStatsUseCase } from "../modules/quality/application/use-cases/get-agent-quality-stats.use-case";
import { AddCoachingNoteUseCase } from "../modules/quality/application/use-cases/add-coaching-note.use-case";
import { MarkReviewReviewedUseCase } from "../modules/quality/application/use-cases/mark-review-reviewed.use-case";
import { BatchEnqueueQualityReviewsUseCase } from "../modules/quality/application/use-cases/batch-enqueue-quality-reviews.use-case";
import { resolveQualityDepartmentScope } from "../modules/quality/application/quality-auth";
import { createQualityRouter } from "../modules/quality/presentation/quality.router";

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
  const customerRepo = new CustomerRepositoryPg(pgPool);
  const contractRepo = new ContractRepositoryPg(pgPool);
  const conversationIdentity = new ConversationIdentityService(
    conversationRepo,
    customerRepo,
    contractRepo,
  );
  const whatsappSender = new WhatsAppSenderHttp(env, conversationsLogger);
  const departmentRepo = new DepartmentRepositoryPg(pgPool);
  const agentRepo = new AgentRepositoryPg(pgPool);
  const sessionStore = new SessionStoreRedis(redisClient);
  const caseRepo = new CaseRepositoryPg(pgPool);
  const workflowExecutionRepo = new WorkflowExecutionRepositoryPg(pgPool);
  const n8nWorkflowRegistryRepo = new N8nWorkflowRegistryRepositoryPg(pgPool);
  const escalationRepo = new EscalationRepositoryPg(pgPool);

  // --- Motor de workflow (Etapa 2 + 8) ---
  // Agregar una definicion nueva no toca WorkflowEngine ni AIProviderPort.
  const workflowEngine = new WorkflowEngine([
    supportInternetWorkflow,
    billingBalanceWorkflow,
    salesPackagesWorkflow,
  ]);
  const departmentResolver = new DepartmentResolverService(departmentRepo);
  const arbitrationService = new CaseArbitrationService(caseRepo, casesLogger);

  // --- Catalogo de n8n + gateway HTTP real (Etapa 3) ---
  const n8nWorkflowRegistryCache = new N8nWorkflowRegistryCache(n8nWorkflowRegistryRepo);
  const n8nGateway = new N8nGatewayHttp(n8nWorkflowRegistryCache, env.API_INTERNAL_KEY, casesLogger);

  // --- AI (Etapa 5) ---
  const aiLogger = logger.child({ module: "ai" });
  let aiProvider: AIProviderPort;
  if (env.AI_PROVIDER === "gemini") {
    if (!env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY es requerida cuando AI_PROVIDER=gemini");
    }
    aiProvider = new GeminiAdapter(
      {
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
        timeoutMs: env.AI_CALL_TIMEOUT_MS,
        qualityTimeoutMs: env.AI_QUALITY_TIMEOUT_MS,
      },
      aiLogger,
    );
  } else {
    aiProvider = new OllamaAdapter(
      {
        baseUrl: env.OLLAMA_BASE_URL,
        model: env.OLLAMA_MODEL,
        timeoutMs: env.AI_CALL_TIMEOUT_MS,
        qualityTimeoutMs: env.AI_QUALITY_TIMEOUT_MS,
      },
      aiLogger,
    );
  }
  const interpretationProvider = new AiInterpretationAdapter(aiProvider, aiLogger);
  const composeReply = new ComposeCustomerReplyUseCase(aiProvider);
  const transcribeAudio = new TranscribeAudioUseCase(aiProvider);
  const extractReceiptData = new ExtractReceiptDataUseCase(aiProvider);

  // --- Calidad (Etapa 10) — antes de complete/expiration que encolan reviews ---
  const qualityLogger = logger.child({ module: "quality" });
  const qualityRepo = new QualityReviewRepositoryPg(pgPool);
  const runQualityAnalysis = new RunQualityAnalysisUseCase({
    qualityRepo,
    messageRepo,
    aiProvider,
    logger: qualityLogger,
    chunkSize: env.QUALITY_ANALYSIS_CHUNK_SIZE,
  });
  const enqueueQualityReview = new EnqueueQualityReviewService({
    qualityRepo,
    messageRepo,
    runQualityAnalysis,
    logger: qualityLogger,
    qualityTimeoutMs: env.AI_QUALITY_TIMEOUT_MS,
    chunkSize: env.QUALITY_ANALYSIS_CHUNK_SIZE,
  });
  const expirationService = new ExpirationService(caseRepo, casesLogger, enqueueQualityReview);
  const listQualityReviews = new ListQualityReviewsUseCase({ qualityRepo, agentRepo });
  const getQualityReview = new GetQualityReviewUseCase({ qualityRepo, agentRepo });
  const getAgentQualityStats = new GetAgentQualityStatsUseCase({ qualityRepo, agentRepo });
  const requestOnDemandReview = new RequestOnDemandReviewUseCase({
    qualityRepo,
    caseRepo,
    agentRepo,
    enqueueService: enqueueQualityReview,
  });
  const addCoachingNote = new AddCoachingNoteUseCase({ qualityRepo, agentRepo, auditRepo });
  const markReviewReviewed = new MarkReviewReviewedUseCase({ qualityRepo, agentRepo, auditRepo });
  const batchEnqueueQualityReviews = new BatchEnqueueQualityReviewsUseCase({
    qualityRepo,
    agentRepo,
    enqueueService: enqueueQualityReview,
  });

  // --- Realtime (Etapa 7) — antes de use cases que emiten eventos ---
  const broadcaster = new RealtimeBroadcaster();

  // --- Escalacion / triage (Etapa 6) ---
  const summaryBuilder = new CaseSummaryBuilderService();
  const autoAssignAgent = new AutoAssignAgentService({
    agentRepo,
    caseRepo,
    maxActiveCasesPerAgent: env.AUTO_ASSIGN_MAX_ACTIVE_CASES_PER_AGENT,
  });
  const escalationService = new EscalationService({
    caseRepo,
    escalationRepo,
    workflowExecutionRepo,
    conversationRepo,
    departmentRepo,
    summaryBuilder,
    logger: escalationLogger,
    broadcaster,
    autoAssign: autoAssignAgent,
    auditRepo,
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
    conversationRepo,
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
    identity: conversationIdentity,
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
    broadcaster,
  });
  const cancelCase = new CancelCaseUseCase({
    caseRepo,
    conversationRepo,
    logger: casesLogger,
    enqueueQualityReview,
  });
  const completeCase = new CompleteCaseUseCase({
    caseRepo,
    conversationRepo,
    auditRepo,
    logger: casesLogger,
    agentRepo,
    departmentRepo,
    enqueueQualityReview,
  });
  const transferCase = new TransferCaseUseCase({
    caseRepo,
    departmentRepo,
    auditRepo,
    logger: casesLogger,
  });
  const getDashboard = new GetDashboardUseCase({
    conversationRepo,
    caseRepo,
    agentRepo,
    escalationRepo,
  });

  const inboundBuffer = new InboundBufferService(
    redisClient,
    async (conversationId, messageIds) => {
      // El correlationId de negocio post-debounce es el del batch (Etapa 9):
      // el webhook puede haber generado varios IDs inbound distintos; la unidad
      // de trabajo agrupa mensajes y traza con un id nuevo documentado aqui.
      const batchCorrelationId = randomUUID();
      ingestionLogger.info(
        {
          correlationId: batchCorrelationId,
          conversationId,
          messageIds,
          messageCount: messageIds.length,
        },
        "flush del buffer inbound: unidad de trabajo lista",
      );
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
    broadcaster,
  });
  const listConversations = new ListConversationsUseCase(
    conversationRepo,
    messageRepo,
    caseRepo,
    agentRepo,
    departmentRepo,
  );
  const listMessages = new ListMessagesUseCase(conversationRepo, messageRepo);
  const markAsRead = new MarkConversationAsReadUseCase(conversationRepo);
  const replyAsHuman = new ReplyAsHumanUseCase({
    conversationRepo,
    messageRepo,
    whatsappSender,
    auditRepo,
    logger: conversationsLogger,
    caseRepo,
    agentRepo,
    departmentRepo,
  });
  const takeControl = new TakeControlUseCase({
    conversationRepo,
    caseRepo,
    claimCase,
    logger: conversationsLogger,
    broadcaster,
  });
  const listDepartments = new ListDepartmentsUseCase(departmentRepo);
  const listAgents = new ListAgentsUseCase(agentRepo);
  const createAgent = new CreateAgentUseCase({ agentRepo, departmentRepo, auditRepo, logger });
  const updateAgent = new UpdateAgentUseCase({ agentRepo, departmentRepo, auditRepo, logger });
  const deactivateAgent = new DeactivateAgentUseCase({ agentRepo, auditRepo, logger });
  const resetAgentPassword = new ResetAgentPasswordUseCase({ agentRepo, auditRepo, logger });

  const createDepartment = new CreateDepartmentUseCase({ departmentRepo, auditRepo, logger });
  const updateDepartment = new UpdateDepartmentUseCase({ departmentRepo, auditRepo, logger });
  const deactivateDepartment = new DeactivateDepartmentUseCase({ departmentRepo, auditRepo, logger });

  const login = new LoginUseCase({
    agentRepo,
    sessionStore,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    logger,
  });
  const logout = new LogoutUseCase(sessionStore);
  const changePassword = new ChangePasswordUseCase({ agentRepo, logger });

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
  app.use(createCors(env.CORS_ALLOWED_ORIGINS, env.NODE_ENV));
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

  // A partir de aqui toda request pasa por la sesion real (docs/spec/06_BACKEND_GAPS.md
  // §1.b) — health y el webhook de WhatsApp quedan afuera a proposito (no
  // tienen identidad de agente; usan su propia verificacion).
  app.use(createSessionMiddleware({ sessionStore, agentRepo, sessionTtlSeconds: env.SESSION_TTL_SECONDS }));
  app.use(createAuthRouter({ login, logout, changePassword, sessionTtlSeconds: env.SESSION_TTL_SECONDS }));

  app.use(
    createConversationsRouter({
      listConversations,
      listMessages,
      markAsRead,
      replyAsHuman,
      takeControl,
      caseRepo,
      broadcaster,
    }),
  );
  app.use(createDepartmentsRouter({ listDepartments, listAgents }));
  app.use(
    createAgentsAdminRouter({
      createAgent,
      updateAgent,
      deactivateAgent,
      resetAgentPassword,
    }),
  );
  app.use(
    createDepartmentsAdminRouter({
      createDepartment,
      updateDepartment,
      deactivateDepartment,
    }),
  );
  app.use(createAuditRouter(auditRepo));
  app.use(
    createN8nWorkflowsRouter({
      listN8nWorkflows,
      upsertN8nWorkflow,
      deactivateN8nWorkflow,
    }),
  );
  app.use(
    createCasesRouter({
      caseRepo,
      workflowExecutionRepo,
      claimCase,
      assignCase,
      disableAutomation,
      reactivateAutomation,
      getCaseSummary,
      completeCase,
      cancelCase,
      transferCase,
      getDashboard,
      broadcaster,
    }),
  );
  app.use(createEscalationsRouter({ listEscalations }));
  app.use(createRealtimeRouter({ broadcaster }));
  app.use(
    createQualityRouter({
      listReviews: listQualityReviews,
      getReview: getQualityReview,
      getAgentStats: getAgentQualityStats,
      requestOnDemand: requestOnDemandReview,
      addCoachingNote,
      markReviewed: markReviewReviewed,
      batchEnqueue: batchEnqueueQualityReviews,
      getPendingCount: async ({ actor, agentId, departmentId }) => {
        const departmentIds = await resolveQualityDepartmentScope(
          actor,
          agentRepo,
          departmentId,
        );
        return qualityRepo.countByStatus("pending", { agentId, departmentIds });
      },
    }),
  );

  app.use(createErrorHandler(logger));

  void enqueueQualityReview.reclaimPending().catch((err) => {
    qualityLogger.warn({ err }, "reclaimPending de quality fallo al arrancar");
  });

  const shutdown = async (): Promise<void> => {
    enqueueQualityReview.stop();
    inboundBuffer.clearAllTimers();
    await Promise.all([pgPool.end(), redisClient.quit().catch(() => undefined)]);
  };

  return { env, app, pgPool, redisClient, logger, inboundBuffer, cancelCase, expirationService, shutdown };
}
