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
  shutdown: () => Promise<void>;
};

export function createContainer(): Container {
  const logger = createLogger(env);
  const pgPool = createPostgresPool(env);
  const redisClient = createRedisClient(env);

  // --- Repositorios (infrastructure) ---
  const auditRepo = new AuditRepositoryPg(pgPool);
  const conversationRepo = new ConversationRepositoryPg(pgPool);
  const messageRepo = new MessageRepositoryPg(pgPool);
  const whatsappSender = new WhatsAppSenderHttp(env);
  const departmentRepo = new DepartmentRepositoryPg(pgPool);
  const agentRepo = new AgentRepositoryPg(pgPool);

  // --- Casos de uso (application) ---
  const receiveInboundMessage = new ReceiveInboundMessageUseCase({
    conversationRepo,
    messageRepo,
    redisClient,
  });
  const listConversations = new ListConversationsUseCase(conversationRepo);
  const listMessages = new ListMessagesUseCase(conversationRepo, messageRepo);
  const replyAsHuman = new ReplyAsHumanUseCase({
    conversationRepo,
    messageRepo,
    whatsappSender,
    auditRepo,
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
    await Promise.all([pgPool.end(), redisClient.quit().catch(() => undefined)]);
  };

  return { env, app, pgPool, redisClient, logger, shutdown };
}
