import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { env } from "../../src/shared/config/env";
import { ConversationRepositoryPg } from "../../src/core/modules/conversations/infrastructure/postgres/conversation.repository.pg";
import { MessageRepositoryPg } from "../../src/core/modules/conversations/infrastructure/postgres/message.repository.pg";
import { ReplyAsHumanUseCase } from "../../src/core/modules/conversations/application/use-cases/reply-as-human.use-case";
import type { WhatsAppSenderPort } from "../../src/core/modules/conversations/application/ports/whatsapp-sender.port";
import { AuditRepositoryPg } from "../../src/core/modules/audit/infrastructure/postgres/audit.repository.pg";

/** Fake del puerto (docs/skills/testing-strategy.md: fakes, no mocks fragiles). */
class FakeWhatsAppSender implements WhatsAppSenderPort {
  public sentTo: string[] = [];

  async sendText(waPhone: string): Promise<{ externalId: string }> {
    this.sentTo.push(waPhone);
    return { externalId: `wamid.fake.${randomUUID()}` };
  }
}

describe("ReplyAsHumanUseCase", () => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const conversationRepo = new ConversationRepositoryPg(pool);
  const messageRepo = new MessageRepositoryPg(pool);
  const auditRepo = new AuditRepositoryPg(pool);

  afterAll(async () => {
    await pool.end();
  });

  it("persiste el mensaje outbound, envia por WhatsApp y audita la accion", async () => {
    const waPhone = `+59398${randomUUID().replace(/-/g, "").slice(0, 7)}`;
    const conversation = await conversationRepo.findOrCreateByWaPhone(waPhone);
    const whatsappSender = new FakeWhatsAppSender();
    const useCase = new ReplyAsHumanUseCase({ conversationRepo, messageRepo, whatsappSender, auditRepo });

    const message = await useCase.execute({
      conversationId: conversation.id,
      agentUserId: randomUUID(),
      body: "Ya estamos revisando tu caso",
    });

    expect(message.direction).toBe("outbound");
    expect(message.author).toBe("agent");
    expect(whatsappSender.sentTo).toEqual([waPhone]);

    const { rows } = await pool.query(
      "SELECT * FROM audit_event WHERE resource_id = $1 AND action = 'CONVERSATION_REPLY'",
      [conversation.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("lanza NOT_FOUND si la conversacion no existe", async () => {
    const whatsappSender = new FakeWhatsAppSender();
    const useCase = new ReplyAsHumanUseCase({ conversationRepo, messageRepo, whatsappSender, auditRepo });

    await expect(
      useCase.execute({ conversationId: randomUUID(), agentUserId: randomUUID(), body: "hola" }),
    ).rejects.toMatchObject({ type: "NOT_FOUND" });
  });
});
