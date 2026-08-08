import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createContainer } from "../../src/core/composition/container";
import { AgentRepositoryPg } from "../../src/core/modules/departments/infrastructure/postgres/agent.repository.pg";

/**
 * Integracion contra la Postgres real de docker-compose.yml (docs/skills/testing-strategy.md).
 * Cubre el criterio de aceptacion de la Etapa 3: autorizacion por `role=admin`
 * y que `PUT` actualiza la URL usada por el gateway sin reiniciar el proceso
 * (docs/spec/05_BUILD_PLAN.md).
 */
describe("GET/PUT/DELETE /api/admin/n8n-workflows (docs/spec/03_API_CONTRACT.md §C.1/§C.2)", () => {
  const container = createContainer();
  const agentRepo = new AgentRepositoryPg(container.pgPool);

  afterAll(async () => {
    await container.shutdown();
  });

  async function seedAgent(role: "agent" | "manager" | "admin"): Promise<string> {
    const agent = await agentRepo.create({
      name: `Test ${role} ${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@example.com`,
      role,
    });
    return agent.id;
  }

  it("rechaza sin header x-agent-id", async () => {
    const response = await request(container.app).get("/api/admin/n8n-workflows");
    expect(response.status).toBe(400);
  });

  it("rechaza a un agente que no es admin", async () => {
    const agentId = await seedAgent("agent");
    const response = await request(container.app).get("/api/admin/n8n-workflows").set("x-agent-id", agentId);
    expect(response.status).toBe(403);
  });

  it("un admin puede listar el catalogo, filtrando por category", async () => {
    const adminId = await seedAgent("admin");

    const all = await request(container.app).get("/api/admin/n8n-workflows").set("x-agent-id", adminId);
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBeGreaterThan(0);

    const adminActionsOnly = await request(container.app)
      .get("/api/admin/n8n-workflows?category=admin_action")
      .set("x-agent-id", adminId);
    expect(adminActionsOnly.status).toBe(200);
    expect(adminActionsOnly.body.data.every((entry: { category: string }) => entry.category === "admin_action")).toBe(
      true,
    );
  });

  it("PUT actualiza la URL de una accion sin reiniciar el proceso; DELETE la desactiva", async () => {
    const adminId = await seedAgent("admin");
    const action = `TEST_ACTION_${randomUUID().slice(0, 8)}`;

    const created = await request(container.app)
      .put(`/api/admin/n8n-workflows/${action}`)
      .set("x-agent-id", adminId)
      .send({ url: "https://n8n.example/v1" });
    expect(created.status).toBe(200);
    expect(created.body.data.url).toBe("https://n8n.example/v1");

    const updated = await request(container.app)
      .put(`/api/admin/n8n-workflows/${action}`)
      .set("x-agent-id", adminId)
      .send({ url: "https://n8n.example/v2" });
    expect(updated.status).toBe(200);
    expect(updated.body.data.url).toBe("https://n8n.example/v2");

    const deactivated = await request(container.app)
      .delete(`/api/admin/n8n-workflows/${action}`)
      .set("x-agent-id", adminId);
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.active).toBe(false);
  });

  it("PUT rechaza una URL /webhook-test/...", async () => {
    const adminId = await seedAgent("admin");
    const response = await request(container.app)
      .put(`/api/admin/n8n-workflows/TEST_ACTION_${randomUUID().slice(0, 8)}`)
      .set("x-agent-id", adminId)
      .send({ url: "https://n8n.example/webhook-test/foo" });
    expect(response.status).toBe(400);
  });

  it("DELETE de una accion inexistente devuelve 404", async () => {
    const adminId = await seedAgent("admin");
    const response = await request(container.app)
      .delete(`/api/admin/n8n-workflows/UNKNOWN_${randomUUID().slice(0, 8)}`)
      .set("x-agent-id", adminId);
    expect(response.status).toBe(404);
  });
});
