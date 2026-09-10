import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createContainer } from "../../src/core/composition/container";
import { AgentRepositoryPg } from "../../src/core/modules/departments/infrastructure/postgres/agent.repository.pg";
import { MessageTemplateRepositoryPg } from "../../src/core/modules/message-templates/infrastructure/postgres/message-template.repository.pg";
import { hashPassword } from "../../src/shared/security/password-hasher";

const TEST_PASSWORD = "Test1234!";

describe("MessageTemplates Router (GET/POST/DELETE /api/message-templates, POST /webhooks/whatsapp/template-status)", () => {
  const container = createContainer();
  const agentRepo = new AgentRepositoryPg(container.pgPool);
  const templateRepo = new MessageTemplateRepositoryPg(container.pgPool);

  afterAll(async () => {
    await container.shutdown();
  });

  async function seedAgent() {
    const email = `${randomUUID()}@example.com`;
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const agent = await agentRepo.create({
      name: `Test Agent ${randomUUID().slice(0, 8)}`,
      email,
      role: "agent",
      passwordHash,
    });
    return { id: agent.id, email };
  }

  async function loginClient() {
    const { email } = await seedAgent();
    const client = request.agent(container.app);
    const res = await client.post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return client;
  }

  it("rechaza peticiones sin autenticación", async () => {
    const res = await request(container.app).get("/api/message-templates");
    expect(res.status).toBe(403);
  });

  it("valida entradas incorrectas en POST con 400", async () => {
    const client = await loginClient();
    const invalidRes = await client.post("/api/message-templates").send({
      name: "INVALID NAME WITH SPACES",
      category: "UTILITY",
      bodyText: "Test body",
    });
    expect(invalidRes.status).toBe(400);
  });

  it("permite a un agente autenticado listar, consultar por id, sincronizar y eliminar una plantilla", async () => {
    const client = await loginClient();
    const id = randomUUID();
    const metaTemplateId = `meta-${randomUUID().slice(0, 8)}`;
    const name = `test_template_${randomUUID().slice(0, 6)}`;

    // Seed directamente en DB para probar endpoints de consulta, sync y delete
    await templateRepo.create({
      id,
      name,
      category: "UTILITY",
      language: "es",
      headerType: "NONE",
      headerContent: null,
      bodyText: "Hola {{1}}, tu código es {{2}}",
      footerText: "ISP Support",
      buttons: null,
      status: "PENDING",
      metaTemplateId,
      rejectedReason: null,
    });

    // 1. GET /api/message-templates (Listar)
    const listRes = await client.get("/api/message-templates?category=UTILITY");
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.templates.some((t: { id: string }) => t.id === id)).toBe(true);

    // 2. GET /api/message-templates/:id (Detalle)
    const getRes = await client.get(`/api/message-templates/${id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.name).toBe(name);

    // 3. POST /webhooks/whatsapp/template-status (Sincronizar estado)
    const syncRes = await client.post("/webhooks/whatsapp/template-status").send({
      metaTemplateId,
      status: "APPROVED",
    });
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.data.status).toBe("APPROVED");

    // 4. DELETE /api/message-templates/:id (Eliminar)
    const delRes = await client.delete(`/api/message-templates/${id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.success).toBe(true);

    // Verificar que ya no existe en DB
    const notFoundRes = await client.get(`/api/message-templates/${id}`);
    expect(notFoundRes.status).toBe(404);
  });
});
