import { describe, expect, it } from "vitest";
import { resolveAnalyticsDepartmentScope } from "../../../src/core/modules/analytics/application/analytics-auth";
import { AgentRepositoryFake } from "../../support/agent-audit.fakes";
import type { Agent } from "../../../src/core/modules/departments/domain/agent.entity";

describe("Analytics Authorization and Scoping (resolveAnalyticsDepartmentScope)", () => {
  const agentRepo = new AgentRepositoryFake();

  const admin: Agent = {
    id: "admin-1",
    name: "Admin Global",
    email: "admin@isp.local",
    role: "admin",
    primaryDepartmentId: "dept-support",
    active: true,
    autoAssignEnabled: false,
    mustChangePassword: false,
    passwordHash: null,
    createdAt: new Date(),
  };

  const manager: Agent = {
    id: "mgr-1",
    name: "Manager Soporte",
    email: "manager@isp.local",
    role: "manager",
    primaryDepartmentId: "dept-support",
    active: true,
    autoAssignEnabled: false,
    mustChangePassword: false,
    passwordHash: null,
    createdAt: new Date(),
  };

  const agent: Agent = {
    id: "ag-1",
    name: "Agente Técnico",
    email: "agente@isp.local",
    role: "agent",
    primaryDepartmentId: "dept-support",
    active: true,
    autoAssignEnabled: true,
    mustChangePassword: false,
    passwordHash: null,
    createdAt: new Date(),
  };

  it("permite a un admin consultar a nivel global (departmentIds = null)", async () => {
    const scope = await resolveAnalyticsDepartmentScope(admin, agentRepo);
    expect(scope).toBeNull();
  });

  it("permite a un admin filtrar por cualquier departamento específico", async () => {
    const scope = await resolveAnalyticsDepartmentScope(admin, agentRepo, "dept-billing");
    expect(scope).toEqual(["dept-billing"]);
  });

  it("restringe a un manager a sus departamentos autorizados si no especifica filtro", async () => {
    await agentRepo.setMemberships("mgr-1", ["dept-sales"]);
    const scope = await resolveAnalyticsDepartmentScope(manager, agentRepo);
    expect(scope).toContain("dept-support");
    expect(scope).toContain("dept-sales");
    expect(scope).toHaveLength(2);
  });

  it("permite a un manager filtrar por un departamento dentro de su alcance", async () => {
    await agentRepo.setMemberships("mgr-1", ["dept-sales"]);
    const scope = await resolveAnalyticsDepartmentScope(manager, agentRepo, "dept-sales");
    expect(scope).toEqual(["dept-sales"]);
  });

  it("rechaza a un manager si intenta acceder a un departamento fuera de su alcance", async () => {
    await agentRepo.setMemberships("mgr-1", ["dept-sales"]);
    await expect(
      resolveAnalyticsDepartmentScope(manager, agentRepo, "dept-foreign"),
    ).rejects.toThrow("No tienes alcance sobre este departamento");
  });

  it("rechaza a un usuario con rol 'agent' con error de autorización", async () => {
    await expect(
      resolveAnalyticsDepartmentScope(agent, agentRepo),
    ).rejects.toThrow("Se requiere rol manager o admin para acceder a analíticas");
  });
});
