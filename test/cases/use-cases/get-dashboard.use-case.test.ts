import { describe, it, expect } from "vitest";
import { GetDashboardUseCase } from "../../../src/core/modules/cases/application/use-cases/get-dashboard.use-case";
import { CaseRepositoryFake } from "../fakes";
import { AgentRepositoryFake } from "../../support/agent-audit.fakes";
import type { Agent } from "../../../src/core/modules/departments/domain/agent.entity";

describe("GetDashboardUseCase (O(1) Cockpit Operativo segmentado por rol)", () => {
  it("computa métricas orientadas al agente (mis casos, desatendidos, esperando usuario)", async () => {
    const caseRepo = new CaseRepositoryFake();
    const agentRepo = new AgentRepositoryFake();

    const agent: Agent = {
      id: "agent-1",
      name: "Juan Perez",
      email: "juan@isp.com",
      role: "agent",
      primaryDepartmentId: "dept-support",
      active: true,
      autoAssignEnabled: true,
      mustChangePassword: false,
      passwordHash: "hash",
      createdAt: new Date(),
    };
    agentRepo.agents.set(agent.id, agent);

    await caseRepo.create({
      conversationId: "conv-1",
      departmentId: "dept-support",
      workflowType: "SUPPORT_INTERNET",
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    // Asignar al agente
    const allCases = [...caseRepo.cases.values()];
    const createdCase = allCases[0]!;
    await caseRepo.setAssignedAgent(createdCase.id, agent.id);
    await caseRepo.applyTransition({
      caseId: createdCase.id,
      expectedCaseVersion: createdCase.version,
      expectedWorkflowVersion: 1,
      status: "HUMAN_ACTIVE",
      context: createdCase.context,
      currentState: "HUMAN_ATTENTION",
      expiresAt: null,
    });

    const useCase = new GetDashboardUseCase({ caseRepo, agentRepo });
    const result = await useCase.execute({ actor: agent });

    expect(result.userId).toBe(agent.id);
    expect(result.role).toBe("agent");
    expect(result.myAssignedCases).toBe(1);
    expect(result.unattendedCases).toBe(1);
    expect(result.openConversations).toBeGreaterThanOrEqual(1);
  });

  it("computa métricas de gerente (cola sin asignar, carga departamental y equipo)", async () => {
    const caseRepo = new CaseRepositoryFake();
    const agentRepo = new AgentRepositoryFake();

    const manager: Agent = {
      id: "manager-1",
      name: "Gerente Soporte",
      email: "gerente@isp.com",
      role: "manager",
      primaryDepartmentId: "dept-support",
      active: true,
      autoAssignEnabled: false,
      mustChangePassword: false,
      passwordHash: "hash",
      createdAt: new Date(),
    };
    agentRepo.agents.set(manager.id, manager);

    // Caso encolado sin asignar
    await caseRepo.create({
      conversationId: "conv-unassigned",
      departmentId: "dept-support",
      workflowType: "SUPPORT_INTERNET",
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "ESCALATED",
      expiresAt: null,
    });
    const unassigned = [...caseRepo.cases.values()][0]!;
    await caseRepo.applyTransition({
      caseId: unassigned.id,
      expectedCaseVersion: unassigned.version,
      expectedWorkflowVersion: 1,
      status: "ESCALATED",
      context: unassigned.context,
      currentState: "ESCALATED_TRIAGE",
      expiresAt: null,
    });

    const useCase = new GetDashboardUseCase({ caseRepo, agentRepo });
    const result = await useCase.execute({ actor: manager });

    expect(result.role).toBe("manager");
    expect(result.unassignedQueue).toBe(1);
    expect(result.departmentCases).toBe(1);
    expect(Array.isArray(result.teamLoad)).toBe(true);
  });

  it("computa métricas de admin globales y tolera compatibilidad con llamadas legacy por string", async () => {
    const caseRepo = new CaseRepositoryFake();
    const agentRepo = new AgentRepositoryFake();

    const admin: Agent = {
      id: "admin-1",
      name: "Super Admin",
      email: "admin@isp.com",
      role: "admin",
      primaryDepartmentId: null,
      active: true,
      autoAssignEnabled: false,
      mustChangePassword: false,
      passwordHash: "hash",
      createdAt: new Date(),
    };
    agentRepo.agents.set(admin.id, admin);

    const useCase = new GetDashboardUseCase({ caseRepo, agentRepo });
    // Llamada legacy pasando solo el ID string
    const result = await useCase.execute(admin.id);

    expect(result.userId).toBe(admin.id);
    expect(result.role).toBe("admin");
    expect(Array.isArray(result.departmentBreakdown)).toBe(true);
  });
});
