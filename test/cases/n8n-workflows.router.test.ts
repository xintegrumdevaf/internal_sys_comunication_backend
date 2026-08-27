import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createContainer } from "../../src/core/composition/container";
import { AgentRepositoryPg } from "../../src/core/modules/departments/infrastructure/postgres/agent.repository.pg";
import { hashPassword } from "../../src/shared/security/password-hasher";

const TEST_PASSWORD = "Test1234!";

/**
 * Integracion contra la Postgres real de docker-compose.yml (docs/skills/testing-strategy.md).
 * Cubre el criterio de aceptacion de la Etapa 3: autorizacion por `role=admin`
 * y que `PUT` actualiza la URL usada por el gateway sin reiniciar el proceso
 * (docs/spec/05_BUILD_PLAN.md). Identidad via sesion real (login + cookie),
 * no via header x-agent-id — docs/spec/06_BACKEND_GAPS.md §1.b.
 */
describe("GET/PUT/DELETE /api/admin/n8n-workflows (docs/spec/03_API_CONTRACT.md §C.1/§C.2)", () => {
  const container = createContainer();
  const agentRepo = new AgentRepositoryPg(container.pgPool);
  const createdAgentIds: string[] = [];

  afterAll(async () => {
    if (createdAgentIds.length > 0) {
      await container.pgPool.query("DELETE FROM n8n_workflow_registry WHERE action LIKE 'TEST_%'");
      await container.pgPool.query("UPDATE n8n_workflow_registry SET updated_by = NULL WHERE updated_by = ANY($1::uuid[])", [createdAgentIds]);
      await container.pgPool.query("DELETE FROM audit_event WHERE actor_id = ANY($1::uuid[])", [createdAgentIds]);
      await container.pgPool.query("DELETE FROM agent WHERE id = ANY($1::uuid[])", [createdAgentIds]);
    }
    await container.shutdown();
  });

  async function seedAgent(role: "agent" | "manager" | "admin") {
    const email = `${randomUUID()}@example.com`;
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const agent = await agentRepo.create({
      name: `Test ${role} ${randomUUID().slice(0, 8)}`,
      email,
      role,
      passwordHash,
    });
    createdAgentIds.push(agent.id);
    return { id: agent.id, email };
  }

  /** supertest.agent() persiste la cookie de sesion entre llamadas (a diferencia de request()). */
  async function loginAs(role: "agent" | "manager" | "admin") {
    const { email } = await seedAgent(role);
    const client = request.agent(container.app);
    const res = await client.post("/api/auth/login").send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return client;
  }

  it("rechaza sin sesion", async () => {
    const response = await request(container.app).get("/api/admin/n8n-workflows");
    expect(response.status).toBe(403);
  });

  it("rechaza a un agente que no es admin", async () => {
    const client = await loginAs("agent");
    const response = await client.get("/api/admin/n8n-workflows");
    expect(response.status).toBe(403);
  });

  it("un admin puede listar el catalogo, filtrando por category", async () => {
    const client = await loginAs("admin");

    const all = await client.get("/api/admin/n8n-workflows");
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBeGreaterThan(0);

    const adminActionsOnly = await client.get("/api/admin/n8n-workflows?category=admin_action");
    expect(adminActionsOnly.status).toBe(200);
    expect(adminActionsOnly.body.data.every((entry: { category: string }) => entry.category === "admin_action")).toBe(
      true,
    );
  });

  it("PUT actualiza la URL de una accion sin reiniciar el proceso; DELETE la desactiva", async () => {
    const client = await loginAs("admin");
    const action = `TEST_ACTION_${randomUUID().slice(0, 8)}`;

    const created = await client.put(`/api/admin/n8n-workflows/${action}`).send({ url: "https://n8n.example/v1" });
    expect(created.status).toBe(200);
    expect(created.body.data.url).toBe("https://n8n.example/v1");

    const updated = await client.put(`/api/admin/n8n-workflows/${action}`).send({ url: "https://n8n.example/v2" });
    expect(updated.status).toBe(200);
    expect(updated.body.data.url).toBe("https://n8n.example/v2");

    const deactivated = await client.delete(`/api/admin/n8n-workflows/${action}`);
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.active).toBe(false);
  });

  it("PUT rechaza una URL /webhook-test/...", async () => {
    const client = await loginAs("admin");
    const response = await client
      .put(`/api/admin/n8n-workflows/TEST_ACTION_${randomUUID().slice(0, 8)}`)
      .send({ url: "https://n8n.example/webhook-test/foo" });
    expect(response.status).toBe(400);
  });

  it("DELETE de una accion inexistente devuelve 404", async () => {
    const client = await loginAs("admin");
    const response = await client.delete(`/api/admin/n8n-workflows/UNKNOWN_${randomUUID().slice(0, 8)}`);
    expect(response.status).toBe(404);
  });
});
