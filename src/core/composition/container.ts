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
import { UnclearInterpretationProvider } from "../modules/cases/infrastructure/synthetic/unclear-interpretation.provider";
import { NotImplementedN8nGateway } from "../modules/cases/infrastructure/synthetic/not-implemented-n8n-gateway";
import { WorkflowEngine } from "../modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../modules/cases/application/engine/definitions/support-internet.workflow";
import { DepartmentResolverService } from "../modules/cases/application/services/department-resolver.service";
import { CaseArbitrationService } from "../modules/cases/application/services/case-arbitration.service";
import { ExpirationService } from "../modules/cases/application/services/expiration.service";
import { AdvanceCaseUseCase } from "../modules/cases/application/use-cases/advance-case.use-case";
import { ProcessBufferedMessagesUseCase } from "../modules/cases/application/use-cases/process-buffered-messages.use-case";
import { CancelCaseUseCase } from "../modules/cases/application/use-cases/cancel-case.use-case";

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

  // --- Repositorios (infrastructure) ---
  const auditRepo = new AuditRepositoryPg(pgPool);
  const conversationRepo = new ConversationRepositoryPg(pgPool);
  const messageRepo = new MessageRepositoryPg(pgPool);
  const whatsappSender = new WhatsAppSenderHttp(env, conversationsLogger);
  const departmentRepo = new DepartmentRepositoryPg(pgPool);
  const agentRepo = new AgentRepositoryPg(pgPool);
  const caseRepo = new CaseRepositoryPg(pgPool);
  const workflowExecutionRepo = new WorkflowExecutionRepositoryPg(pgPool);

  // --- Motor de workflow (Etapa 2) ---
  // Unico workflow implementado por ahora (docs/spec/05_BUILD_PLAN.md Etapa 2);
  // BILLING_BALANCE/SALES_PACKAGES se agregan en la Etapa 8 sin tocar el motor.
  const workflowEngine = new WorkflowEngine([supportInternetWorkflow]);
  const departmentResolver = new DepartmentResolverService(departmentRepo);
  const arbitrationService = new CaseArbitrationService(caseRepo, casesLogger);
  const expirationService = new ExpirationService(caseRepo, casesLogger);

  // Placeholders explicitos hasta que existan sus etapas reales:
  // - N8nGatewayPort real (HTTP + n8n_workflow_registry) llega en la Etapa 3.
  // - InterpretationPort real (AIProviderPort/OllamaAdapter) llega en la Etapa 5.
  // Mientras tanto la interpretacion siempre es UNCLEAR, asi que el gateway
  // nunca se invoca en produccion (ver comentarios en ambas clases).
  const n8nGateway = new NotImplementedN8nGateway();
  const interpretationProvider = new UnclearInterpretationProvider();

  // --- Casos de uso (application) ---
  const advanceCase = new AdvanceCaseUseCase({
    caseRepo,
    workflowExecutionRepo,
    conversationRepo,
    engine: workflowEngine,
    gateway: n8nGateway,
    logger: casesLogger,
  });
  const processBufferedMessages = new ProcessBufferedMessagesUseCase({
    caseRepo,
    conversationRepo,
    departmentResolver,
    arbitrationService,
    interpretationProvider,
    engine: workflowEngine,
    advanceCase,
    logger: casesLogger,
  });
  const cancelCase = new CancelCaseUseCase({ caseRepo, conversationRepo, logger: casesLogger });

  const inboundBuffer = new InboundBufferService(
    redisClient,
    async (conversationId, messageIds) => {
      // Nueva unidad de trabajo: el correlationId de cada request HTTP que
      // aporto un mensaje ya quedo logueado en ReceiveInboundMessageUseCase;
      // de aqui en adelante (interpretacion -> caso -> ejecucion) todo se
      // traza bajo este nuevo correlationId de lote (AGENTS.md end-to-end).
      const batchCorrelationId = randomUUID();
      const messages = await messageRepo.findByIds(messageIds);
      const text = messages.map((message) => message.body).join("\n");
      await processBufferedMessages.execute({
        conversationId,
        correlationId: batchCorrelationId,
        text,
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
  });
  const listDepartments = new ListDepartmentsUseCase(departmentRepo);
  const listAgents = new ListAgentsUseCase(agentRepo);

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

  app.use(createErrorHandler(logger));

  const shutdown = async (): Promise<void> => {
    inboundBuffer.clearAllTimers();
    await Promise.all([pgPool.end(), redisClient.quit().catch(() => undefined)]);
  };

  return { env, app, pgPool, redisClient, logger, inboundBuffer, cancelCase, expirationService, shutdown };
}
