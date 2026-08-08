import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type { Env } from "../config/env";

export function createRedisClient(env: Env): Redis {
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  client.on("error", (error) => {
    console.error("[redis] error inesperado en el cliente", error);
  });

  return client;
}

export async function checkRedisConnection(client: Redis): Promise<boolean> {
  try {
    if (client.status === "wait" || client.status === "end") {
      await client.connect();
    }
    const reply = await client.ping();
    return reply === "PONG";
  } catch {
    return false;
  }
}

const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

export type ConversationLockOptions = {
  ttlMs?: number;
  retryDelayMs?: number;
  maxWaitMs?: number;
};

/**
 * Serializacion por conversacion (docs/spec/00_OVERVIEW.md §3, 05_BUILD_PLAN.md Etapa 1).
 *
 * `conversation.wa_phone` no tiene constraint UNIQUE a nivel de base (solo indice),
 * asi que sin este lock dos mensajes concurrentes del mismo numero podrian crear
 * dos conversaciones distintas (race condition). El lock se toma sobre `wa_phone`
 * porque la conversacion puede no existir aun cuando llega el primer mensaje.
 */
export async function withConversationLock<T>(
  redisClient: Redis,
  waPhone: string,
  fn: () => Promise<T>,
  options: ConversationLockOptions = {},
): Promise<T> {
  const { ttlMs = 10_000, retryDelayMs = 50, maxWaitMs = 5_000 } = options;
  const lockKey = `lock:conversation:${waPhone}`;
  const lockToken = randomUUID();
  const deadline = Date.now() + maxWaitMs;

  while (true) {
    const acquired = await redisClient.set(lockKey, lockToken, "PX", ttlMs, "NX");
    if (acquired === "OK") {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`No se pudo adquirir el lock de conversacion para ${waPhone}`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  try {
    return await fn();
  } finally {
    await redisClient.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken);
  }
}

/**
 * Encolado para procesamiento asincrono posterior a la persistencia del mensaje
 * crudo (docs/spec/00_OVERVIEW.md regla #3). El consumidor (worker interno de
 * Etapa 2) todavia no existe; esta cola solo deja la senal lista.
 */
export async function enqueueConversationJob(
  redisClient: Redis,
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await redisClient.lpush(`queue:conversation:${conversationId}`, JSON.stringify(payload));
}
