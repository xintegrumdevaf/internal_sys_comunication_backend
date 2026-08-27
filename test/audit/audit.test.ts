import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createContainer } from "../../src/core/composition/container";
import { AgentRepositoryPg } from "../../src/core/modules/departments/infrastructure/postgres/agent.repository.pg";
import { DepartmentRepositoryPg } from "../../src/core/modules/departments/infrastructure/postgres/department.repository.pg";
import { AuditRepositoryPg } from "../../src/core/modules/audit/infrastructure/postgres/audit.repository.pg";
import { hashPassword } from "../../src/shared/security/password-hasher";

const TEST_PASSWORD = "TestPassword123!";

describe("Sistema de Auditoría Empresarial (Enterprise Audit System)", () => {
  const container = createContainer();
  const agentRepo = new AgentRepositoryPg(container.pgPool);
  const departmentRepo = new DepartmentRepositoryPg(container.pgPool);
  const auditRepo = new AuditRepositoryPg(container.pgPool);
  const createdAgentIds: string[] = [];
  const createdDepartmentIds: string[] = [];

  afterAll(async () => {
    if (createdDepartmentIds.length > 0) {
      await container.pgPool.query("DELETE FROM audit_event WHERE department_id = ANY($1::uuid[])", [createdDepartmentIds]);
    }
    if (createdAgentIds.length > 0) {
      await container.pgPool.query("DELETE FROM audit_event WHERE actor_id = ANY($1::uuid[])", [createdAgentIds]);
      await container.pgPool.query("DELETE FROM agent_membership WHERE agent_id = ANY($1::uuid[])", [createdAgentIds]);
      await container.pgPool.query("DELETE FROM agent WHERE id = ANY($1::uuid[])", [createdAgentIds]);
    }
    if (createdDepartmentIds.length > 0) {
      await container.pgPool.query("DELETE FROM department WHERE id = ANY($1::uuid[])", [createdDepartmentIds]);
    }
    await container.shutdown();
  });

  async function createTestDepartment(name: string) {
    const slug = `dept_${randomUUID().slice(0, 8)}`;
    const dept = await departmentRepo.create({ slug, name });
    createdDepartmentIds.push(dept.id);
    return dept;
  }

  async function createTestAgent(
    role: "agent" | "manager" | "admin" = "agent",
    primaryDepartmentId?: string
  ) {
    const email = `audit_${randomUUID()}@example.com`;
    const passwordHash = await hashPassword(TEST_PASSWORD);
    const agent = await agentRepo.create({
      name: `Audit Agent ${role} ${randomUUID().slice(0, 6)}`,
      email,
      role,
      passwordHash,
      primaryDepartmentId,
    });
    createdAgentIds.push(agent.id);
    return agent;
  }

  async function loginClient(agentEmail: string) {
    const client = request.agent(container.app);
    const res = await client
      .post("/api/auth/login")
      .send({ email: agentEmail, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return client;
  }

  it("rechaza peticiones sin autenticación (403)", async () => {
    const res = await request(container.app).get("/api/audit");
    expect(res.status).toBe(403);
  });

  it("rechaza acceso a agentes con rol 'agent' (403)", async () => {
    const regularAgent = await createTestAgent("agent");
    const client = await loginClient(regularAgent.email);

    const res = await client.get("/api/audit");
    expect(res.status).toBe(403);
  });

  it("permite a un 'admin' consultar eventos con filtros avanzados, joins y estados diff", async () => {
    const admin = await createTestAgent("admin");
    const dept = await createTestDepartment("Soporte Auditoría");
    const client = await loginClient(admin.email);

    // Grabamos eventos de prueba enriquecidos
    const correlationId = `corr_${randomUUID()}`;
    await auditRepo.record({
      action: "DEPARTMENT_UPDATED",
      category: "data_change",
      resourceType: "department",
      resourceId: dept.id,
      actorType: "agent",
      actorId: admin.id,
      departmentId: dept.id,
      metadata: { field: "name" },
      beforeState: { name: dept.name },
      afterState: { name: "Soporte Auditoría Modificado" },
      ipAddress: "127.0.0.1",
      userAgent: "Vitest/TestRunner",
      correlationId,
    });

    const res = await client.get(`/api/audit?action=DEPARTMENT_UPDATED&departmentId=${dept.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);

    const event = res.body.data.find((e: { resourceId: string }) => e.resourceId === dept.id);
    expect(event).toBeDefined();
    expect(event.action).toBe("DEPARTMENT_UPDATED");
    expect(event.category).toBe("data_change");
    expect(event.actor.id).toBe(admin.id);
    expect(event.actor.name).toBe(admin.name);
    expect(event.actor.email).toBe(admin.email);
    expect(event.department.id).toBe(dept.id);
    expect(event.department.name).toBe(dept.name);
    expect(event.beforeState).toEqual({ name: dept.name });
    expect(event.afterState).toEqual({ name: "Soporte Auditoría Modificado" });
    expect(event.ipAddress).toBe("127.0.0.1");
    expect(event.correlationId).toBe(correlationId);
  });

  it("aplica aislamiento de alcance para un 'manager'", async () => {
    const deptA = await createTestDepartment("Depto Manager A");
    const deptB = await createTestDepartment("Depto Manager B");
    const manager = await createTestAgent("manager", deptA.id);
    const client = await loginClient(manager.email);

    // Evento en Depto A
    await auditRepo.record({
      action: "CASE_CLAIMED",
      category: "operational",
      resourceType: "case",
      resourceId: randomUUID(),
      actorType: "agent",
      actorId: manager.id,
      departmentId: deptA.id,
      metadata: { caseNumber: 101 },
    });

    // Evento en Depto B (ajeno al manager)
    await auditRepo.record({
      action: "CASE_CLAIMED",
      category: "operational",
      resourceType: "case",
      resourceId: randomUUID(),
      actorType: "system",
      actorId: null,
      departmentId: deptB.id,
      metadata: { caseNumber: 102 },
    });

    // Manager consultando su alcance: debe ver solo Depto A
    const res = await client.get("/api/audit");
    expect(res.status).toBe(200);
    const hasDeptB = res.body.data.some(
      (e: { department?: { id: string } }) => e.department?.id === deptB.id
    );
    expect(hasDeptB).toBe(false);

    // Si intenta forzar departmentId=deptB ajeno, debe recibir 403
    const resForbidden = await client.get(`/api/audit?departmentId=${deptB.id}`);
    expect(resForbidden.status).toBe(403);
  });

  it("GET /api/audit/stats entrega métricas agregadas por categoría y top acciones", async () => {
    const admin = await createTestAgent("admin");
    const client = await loginClient(admin.email);

    const res = await client.get("/api/audit/stats");
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.totalEvents).toBeGreaterThanOrEqual(1);
    expect(res.body.data.byCategory).toHaveProperty("security");
    expect(res.body.data.byCategory).toHaveProperty("operational");
    expect(res.body.data.byCategory).toHaveProperty("data_change");
    expect(Array.isArray(res.body.data.topActions)).toBe(true);
    expect(Array.isArray(res.body.data.topActors)).toBe(true);
  });

  it("soporta paginación por cursor en /api/audit", async () => {
    const admin = await createTestAgent("admin");
    const client = await loginClient(admin.email);

    const resPage1 = await client.get("/api/audit?limit=2");
    expect(resPage1.status).toBe(200);
    expect(resPage1.body.data.length).toBeLessThanOrEqual(2);

    if (resPage1.body.pagination.nextCursor) {
      const resPage2 = await client.get(
        `/api/audit?limit=2&cursor=${encodeURIComponent(resPage1.body.pagination.nextCursor)}`
      );
      expect(resPage2.status).toBe(200);
      expect(resPage2.body.data.length).toBeGreaterThan(0);
    }
  });
});
