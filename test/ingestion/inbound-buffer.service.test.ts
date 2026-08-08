import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { env } from "../../src/shared/config/env";
import { InboundBufferService } from "../../src/core/modules/ingestion/application/services/inbound-buffer.service";
import { silentLogger } from "../support/silent-logger";

/**
 * Integracion contra el Redis real de docker-compose.yml (docs/skills/testing-strategy.md).
 * Cubre el criterio de aceptacion de la Etapa 2: "el buffer agrupa 3 mensajes
 * seguidos en una sola unidad de trabajo tras el debounce".
 */
describe("InboundBufferService (docs/spec/02_STATE_MACHINE.md §12)", () => {
  const redisClient = new Redis(env.REDIS_URL);

  afterAll(() => {
    redisClient.disconnect();
  });

  it("agrupa varios mensajes seguidos de la misma conversacion en un solo flush", async () => {
    const conversationId = randomUUID();
    const flushes: string[][] = [];

    const buffer = new InboundBufferService(
      redisClient,
      async (_conversationId, messageIds) => {
        flushes.push(messageIds);
      },
      { debounceMs: 150 },
      silentLogger,
    );

    await buffer.push(conversationId, "msg-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await buffer.push(conversationId, "msg-2");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await buffer.push(conversationId, "msg-3");

    // Cada push reprograma el debounce; solo debe dispararse una vez, ~150ms despues del ultimo push.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("una segunda rafaga tras un flush se procesa como una unidad de trabajo nueva e independiente", async () => {
    const conversationId = randomUUID();
    const flushes: string[][] = [];

    const buffer = new InboundBufferService(
      redisClient,
      async (_conversationId, messageIds) => {
        flushes.push(messageIds);
      },
      { debounceMs: 100 },
      silentLogger,
    );

    await buffer.push(conversationId, "a-1");
    await new Promise((resolve) => setTimeout(resolve, 200));

    await buffer.push(conversationId, "b-1");
    await buffer.push(conversationId, "b-2");
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(flushes).toEqual([["a-1"], ["b-1", "b-2"]]);
  });

  it("conversaciones distintas se debounce de forma independiente", async () => {
    const conversationA = randomUUID();
    const conversationB = randomUUID();
    const flushed = new Map<string, string[]>();

    const buffer = new InboundBufferService(
      redisClient,
      async (conversationId, messageIds) => {
        flushed.set(conversationId, messageIds);
      },
      { debounceMs: 120 },
      silentLogger,
    );

    await buffer.push(conversationA, "a-1");
    await buffer.push(conversationB, "b-1");
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(flushed.get(conversationA)).toEqual(["a-1"]);
    expect(flushed.get(conversationB)).toEqual(["b-1"]);
  });
});
