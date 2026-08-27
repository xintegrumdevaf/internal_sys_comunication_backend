import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createContainer } from "../../src/core/composition/container";
import { AgentRepositoryPg } from "../../src/core/modules/departments/infrastructure/postgres/agent.repository.pg";
import { hashPassword } from "../../src/shared/security/password-hasher";

const TEST_PASSWORD = "TestPassword123!";

describe("Chat Interno Staff Persistente (Etapa 11 - docs/spec/05_BUILD_PLAN.md)", () => {
  const container = createContainer();
  const agentRepo = new AgentRepositoryPg(container.pgPool);
  const createdAgentIds: string[] = [];

  afterAll(async () => {
    if (createdAgentIds.length > 0) {
      await container.pgPool.query("DELETE FROM internal_message WHERE sender_agent_id = ANY($1::uuid[])", [createdAgentIds]);
      await container.pgPool.query("DELETE FROM internal_thread WHERE id IN (SELECT thread_id FROM internal_thread_participant WHERE agent_id = ANY($1::uuid[]))", [createdAgentIds]);
      await container.pgPool.query("DELETE FROM internal_thread_participant WHERE agent_id = ANY($1::uuid[])", [createdAgentIds]);
      await container.pgPool.query("DELETE FROM agent WHERE id = ANY($1::uuid[])", [createdAgentIds]);
    }
    await container.shutdown();
  });

  async function createAgent(role: "agent" | "manager" | "admin" = "agent") {
    const email = `agent_${randomUUID()}@example.com`;
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const agent = await agentRepo.create({
      name: `Agent ${role} ${randomUUID().slice(0, 6)}`,
      email,
      role,
      passwordHash,
    });
    createdAgentIds.push(agent.id);
    return agent;
  }

  async function loginClient(agentEmail: string) {
    const client = request.agent(container.app);
    const res = await client.post("/api/auth/login").send({ email: agentEmail, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return client;
  }

  it("rechaza peticiones sin autenticacion con 403", async () => {
    const res = await request(container.app).get("/api/internal/threads");
    expect(res.status).toBe(403);
  });

  it("POST /api/internal/threads/direct valida agentes e idempotencia", async () => {
    const agentA = await createAgent("manager");
    const agentB = await createAgent("agent");

    const clientA = await loginClient(agentA.email);

    // No permite chat consigo mismo
    const selfRes = await clientA
      .post("/api/internal/threads/direct")
      .send({ peerAgentId: agentA.id });
    expect(selfRes.status).toBe(400);

    // No permite agente inexistente
    const notFoundRes = await clientA
      .post("/api/internal/threads/direct")
      .send({ peerAgentId: randomUUID() });
    expect(notFoundRes.status).toBe(404);

    // Crea chat 1:1
    const createRes = await clientA
      .post("/api/internal/threads/direct")
      .send({ peerAgentId: agentB.id });
    expect(createRes.status).toBe(200);
    expect(createRes.body.data).toHaveProperty("id");
    expect(createRes.body.data.type).toBe("direct");
    const threadId = createRes.body.data.id;

    // Idempotencia: pedir el chat 1:1 de nuevo retorna el mismo threadId
    const secondRes = await clientA
      .post("/api/internal/threads/direct")
      .send({ peerAgentId: agentB.id });
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.data.id).toBe(threadId);

    // Y el peer B tambien obtiene el mismo threadId al pedir chat con A
    const clientB = await loginClient(agentB.email);
    const peerRes = await clientB
      .post("/api/internal/threads/direct")
      .send({ peerAgentId: agentA.id });
    expect(peerRes.status).toBe(200);
    expect(peerRes.body.data.id).toBe(threadId);
  });

  it("envio de mensajes tradicionales y quality_quote con contexto tipado", async () => {
    const supervisor = await createAgent("manager");
    const agent = await createAgent("agent");
    const outsider = await createAgent("agent");

    const supervisorClient = await loginClient(supervisor.email);
    const agentClient = await loginClient(agent.email);
    const outsiderClient = await loginClient(outsider.email);

    // Crear hilo 1:1
    const threadRes = await supervisorClient
      .post("/api/internal/threads/direct")
      .send({ peerAgentId: agent.id });
    const threadId = threadRes.body.data.id;

    // Supervisor envia mensaje tradicional
    const msg1Res = await supervisorClient
      .post(`/api/internal/threads/${threadId}/messages`)
      .send({
        body: "Hola, te paso el feedback de la auditoria de hoy.",
        type: "text",
      });
    expect(msg1Res.status).toBe(201);
    expect(msg1Res.body.data.senderAgentId).toBe(supervisor.id);
    expect(msg1Res.body.data.senderAgentName).toBe(supervisor.name);
    expect(msg1Res.body.data.type).toBe("text");

    // Supervisor envia tarjeta de calidad (quality_quote)
    const quoteContext = {
      qualityReviewId: randomUUID(),
      originalMessageId: randomUUID(),
      category: "disrespect",
      severity: "high",
      excerpt: "Si no le gusta el servicio déselo de baja usted mismo.",
      cordialityScore: 30,
    };

    const msg2Res = await supervisorClient
      .post(`/api/internal/threads/${threadId}/messages`)
      .send({
        body: "Revisa esta respuesta por favor, no cumple el protocolo de cordialidad.",
        type: "quality_quote",
        contextData: quoteContext,
      });
    expect(msg2Res.status).toBe(201);
    expect(msg2Res.body.data.type).toBe("quality_quote");
    expect(msg2Res.body.data.contextData).toMatchObject(quoteContext);

    // Agente responde en el mismo hilo
    const replyRes = await agentClient
      .post(`/api/internal/threads/${threadId}/messages`)
      .send({
        body: "Entendido, ya no ocurrira. El cliente me habia insultado antes.",
        type: "text",
      });
    expect(replyRes.status).toBe(201);
    expect(replyRes.body.data.senderAgentId).toBe(agent.id);

    // Outsider no participante recibe 403 al intentar enviar mensaje
    const outsiderSendRes = await outsiderClient
      .post(`/api/internal/threads/${threadId}/messages`)
      .send({ body: "Intruso" });
    expect(outsiderSendRes.status).toBe(403);

    // Outsider no participante recibe 403 al intentar leer mensajes
    const outsiderListRes = await outsiderClient.get(`/api/internal/threads/${threadId}/messages`);
    expect(outsiderListRes.status).toBe(403);
  });

  it("list-messages pagina correctamente y list-threads refleja unreadCount y mark-as-read", async () => {
    const supervisor = await createAgent("manager");
    const agent = await createAgent("agent");

    const supervisorClient = await loginClient(supervisor.email);
    const agentClient = await loginClient(agent.email);

    // Crear hilo
    const threadRes = await supervisorClient
      .post("/api/internal/threads/direct")
      .send({ peerAgentId: agent.id });
    const threadId = threadRes.body.data.id;

    // Supervisor manda 3 mensajes seguidos
    await supervisorClient.post(`/api/internal/threads/${threadId}/messages`).send({ body: "Msg 1" });
    await supervisorClient.post(`/api/internal/threads/${threadId}/messages`).send({ body: "Msg 2" });
    await supervisorClient.post(`/api/internal/threads/${threadId}/messages`).send({ body: "Msg 3" });

    // Agente lista sus hilos: unreadCount debe ser 3
    const agentThreadsRes = await agentClient.get("/api/internal/threads");
    expect(agentThreadsRes.status).toBe(200);
    const myThread = agentThreadsRes.body.data.find((t: { id: string }) => t.id === threadId);
    expect(myThread).toBeDefined();
    expect(myThread.unreadCount).toBe(3);
    expect(myThread.lastMessage.body).toBe("Msg 3");

    // Agente lee los mensajes con limit=2
    const listRes = await agentClient.get(`/api/internal/threads/${threadId}/messages?limit=2`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(2);
    expect(listRes.body.pagination.nextCursor).not.toBeNull();

    // Agente marca el hilo como leido
    const readRes = await agentClient.post(`/api/internal/threads/${threadId}/read`);
    expect(readRes.status).toBe(200);

    // Tras marcar como leido, unreadCount es 0
    const updatedThreadsRes = await agentClient.get("/api/internal/threads");
    const updatedThread = updatedThreadsRes.body.data.find((t: { id: string }) => t.id === threadId);
    expect(updatedThread.unreadCount).toBe(0);
  });
});
