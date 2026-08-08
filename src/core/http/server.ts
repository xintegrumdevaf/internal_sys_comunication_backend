import type { Server } from "node:http";
import type { Container } from "../composition/container";

export function startServer(container: Container): Server {
  const { app, env } = container;

  const server = app.listen(env.PORT, () => {
    console.log(`[http] API escuchando en el puerto ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[http] señal ${signal} recibida, cerrando servidor...`);
    server.close(async () => {
      await container.shutdown();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return server;
}
