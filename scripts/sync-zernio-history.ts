import { Pool } from "pg";
import { env } from "../src/shared/config/env";
import { createLogger } from "../src/shared/logging/logger";
import { createRedisClient } from "../src/shared/queue/redis";
import { ConversationRepositoryPg } from "../src/core/modules/conversations/infrastructure/postgres/conversation.repository.pg";
import { MessageRepositoryPg } from "../src/core/modules/conversations/infrastructure/postgres/message.repository.pg";
import { ZernioHistoryGatewayHttp } from "../src/core/modules/conversations/infrastructure/zernio/zernio-history.gateway.http";
import { ZernioHistorySyncWorker } from "../src/core/modules/conversations/infrastructure/queue/zernio-history-sync.worker";
import { StartZernioHistorySyncUseCase } from "../src/core/modules/conversations/application/use-cases/start-zernio-history-sync.use-case";
import { GetZernioHistorySyncStatusUseCase } from "../src/core/modules/conversations/application/use-cases/get-zernio-history-sync-status.use-case";

async function main(): Promise<void> {
  console.log("====================================================================");
  console.log("   Sincronizacion Historica de Conversaciones Zernio -> PostgreSQL   ");
  console.log("====================================================================\n");

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const redisClient = createRedisClient(env);
  const logger = createLogger(env).child({ module: "zernio-sync-cli" });

  const conversationRepo = new ConversationRepositoryPg(pool);
  const messageRepo = new MessageRepositoryPg(pool);
  const historyGateway = new ZernioHistoryGatewayHttp(env, logger);

  const worker = new ZernioHistorySyncWorker(
    redisClient,
    historyGateway,
    conversationRepo,
    messageRepo,
    logger,
  );
  worker.startWorker(1000);

  const startSync = new StartZernioHistorySyncUseCase(
    redisClient,
    historyGateway,
    worker,
    logger,
  );
  const getStatus = new GetZernioHistorySyncStatusUseCase(redisClient);

  try {
    const startResult = await startSync.execute();
    if (startResult.alreadyRunning) {
      console.log("(!) Ya habia una sincronizacion en curso. Acoplandose al progreso...\n");
    } else {
      console.log(`(i) Sincronizacion iniciada. Total de conversaciones a procesar: ${startResult.progress.totalConversations}\n`);
    }

    // Monitoreo en vivo en consola
    let lastPercentage = -1;
    while (true) {
      const status = await getStatus.execute();

      if (status.percentage !== lastPercentage || status.currentPhone) {
        const barLength = 20;
        const filled = Math.round((status.percentage / 100) * barLength);
        const bar = "█".repeat(filled) + "-".repeat(barLength - filled);
        const phone = status.currentPhone ? ` | Procesando: ${status.currentPhone}` : "";

        process.stdout.write(
          `\r[${bar}] ${status.percentage}% (${status.processedConversations + status.failedConversations}/${status.totalConversations} convs) | Msg importados: ${status.totalMessagesImported}${phone}   `,
        );
        lastPercentage = status.percentage;
      }

      if (status.status === "COMPLETED" || status.status === "PARTIALLY_FAILED" || status.status === "FAILED") {
        console.log("\n");
        console.log("--------------------------------------------------------------------");
        console.log(`Estado final: ${status.status}`);
        console.log(`Conversaciones procesadas: ${status.processedConversations}`);
        console.log(`Conversaciones fallidas:   ${status.failedConversations}`);
        console.log(`Mensajes importados:       ${status.totalMessagesImported}`);
        console.log(`Mensajes omitidos (dupl):  ${status.totalMessagesSkipped}`);

        if (status.errors && status.errors.length > 0) {
          console.log("\nErrores registrados durante el proceso:");
          for (const err of status.errors) {
            console.log(` - Tel: ${err.phone} (ID: ${err.conversationId}): ${err.error}`);
          }
        }
        console.log("--------------------------------------------------------------------\n");
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error("\nError critico en ejecucion de script:", error);
    process.exitCode = 1;
  } finally {
    worker.stopWorker();
    await redisClient.quit();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fallo inesperado:", err);
  process.exit(1);
});
