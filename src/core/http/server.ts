import type { Server } from "node:http";
import type { Container } from "../composition/container";

export function startServer(container: Container): Server {
  const { app, env, logger } = container;
  const httpLog = logger.child({ module: "http" });

  const server = app.listen(env.PORT, () => {
    httpLog.info({ path: `:${env.PORT}` }, `API escuchando (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    httpLog.warn(`señal ${signal} recibida, cerrando servidor...`);
    server.close(async () => {
      await container.shutdown();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return server;
}
