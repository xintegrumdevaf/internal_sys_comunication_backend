import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import Redis from "ioredis";
import { env } from "../../src/shared/config/env";
import { ConversationRepositoryPg } from "../../src/core/modules/conversations/infrastructure/postgres/conversation.repository.pg";
import { MessageRepositoryPg } from "../../src/core/modules/conversations/infrastructure/postgres/message.repository.pg";
import { ReceiveInboundMessageUseCase } from "../../src/core/modules/conversations/application/use-cases/receive-inbound-message.use-case";
import { silentLogger } from "../support/silent-logger";

/**
 * Test de integracion (docs/skills/testing-strategy.md): contra la Postgres
 * y el Redis reales de docker-compose.yml. Cubre el criterio de aceptacion
 * de la Etapa 1 (05_BUILD_PLAN.md).
 */
describe("ReceiveInboundMessageUseCase", () => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const redisClient = new Redis(env.REDIS_URL);
  const conversationRepo = new ConversationRepositoryPg(pool);
  const messageRepo = new MessageRepositoryPg(pool);
  const useCase = new ReceiveInboundMessageUseCase({ conversationRepo, messageRepo, redisClient, logger: silentLogger });

  afterAll(async () => {
    await pool.end();
    redisClient.disconnect();
  });

  function uniquePhone(): string {
    return `+59399${randomUUID().replace(/-/g, "").slice(0, 7)}`;
  }

  it("crea una nueva conversacion cuando no existe una para el wa_phone", async () => {
    const waPhone = uniquePhone();

    const result = await useCase.execute({
      waPhone,
      externalId: randomUUID(),
      body: "Hola",
      type: "text",
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.conversation.waPhone).toBe(waPhone);

    const { rows } = await pool.query("SELECT count(*) FROM conversation WHERE wa_phone = $1", [waPhone]);
    expect(Number(rows[0].count)).toBe(1);
  });

  it("un mensaje con external_id (waMessageId) repetido no duplica", async () => {
    const waPhone = uniquePhone();
    const externalId = randomUUID();

    const first = await useCase.execute({ waPhone, externalId, body: "Hola", type: "text" });
    const second = await useCase.execute({ waPhone, externalId, body: "Hola", type: "text" });

    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(true);
    expect(second.message.id).toBe(first.message.id);

    const { rows } = await pool.query(
      "SELECT count(*) FROM message WHERE conversation_id = $1",
      [first.conversation.id],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("una conversacion existente se reutiliza para un segundo mensaje del mismo wa_phone", async () => {
    const waPhone = uniquePhone();

    const first = await useCase.execute({ waPhone, externalId: randomUUID(), body: "Hola", type: "text" });
    const second = await useCase.execute({
      waPhone,
      externalId: randomUUID(),
      body: "Sigo aqui",
      type: "text",
    });

    expect(second.conversation.id).toBe(first.conversation.id);

    const { rows } = await pool.query("SELECT count(*) FROM conversation WHERE wa_phone = $1", [waPhone]);
    expect(Number(rows[0].count)).toBe(1);
  });

  it("mensajes concurrentes del mismo wa_phone se serializan y comparten una sola conversacion", async () => {
    const waPhone = uniquePhone();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        useCase.execute({ waPhone, externalId: `${waPhone}-${i}`, body: `Mensaje ${i}`, type: "text" }),
      ),
    );

    const conversationIds = new Set(results.map((r) => r.conversation.id));
    expect(conversationIds.size).toBe(1);

    const conversationId = [...conversationIds][0]!;
    const { rows } = await pool.query("SELECT count(*) FROM conversation WHERE wa_phone = $1", [waPhone]);
    expect(Number(rows[0].count)).toBe(1);

    const { rows: messageRows } = await pool.query(
      "SELECT count(*) FROM message WHERE conversation_id = $1",
      [conversationId],
    );
    expect(Number(messageRows[0].count)).toBe(5);
  });
});
