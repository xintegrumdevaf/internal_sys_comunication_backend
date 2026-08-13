import { describe, expect, it } from "vitest";
import { AutoAssignAgentService } from "../../../src/core/modules/escalation/application/services/auto-assign-agent.service";
import { CaseRepositoryFake } from "../../cases/fakes";
import { AgentRepositoryFake } from "../../support/agent-audit.fakes";

function build(maxActiveCasesPerAgent = 6) {
  const agentRepo = new AgentRepositoryFake();
  const caseRepo = new CaseRepositoryFake();
  const service = new AutoAssignAgentService({ agentRepo, caseRepo, maxActiveCasesPerAgent });
  return { agentRepo, caseRepo, service };
}

async function seedHumanActiveCase(caseRepo: CaseRepositoryFake, agentId: string, departmentId: string) {
  const { case: created } = await caseRepo.create({
    conversationId: "conv-x",
    workflowType: "SUPPORT_INTERNET",
    departmentId,
    context: { workflowType: "SUPPORT_INTERNET", data: {} },
    initialState: "VALIDATE_CLIENT",
    expiresAt: null,
  });
  await caseRepo.applyTransition({
    caseId: created.id,
    expectedCaseVersion: created.version,
    expectedWorkflowVersion: 1,
    status: "HUMAN_ACTIVE",
    context: created.context,
    currentState: "VALIDATE_CLIENT",
    expiresAt: null,
  });
  await caseRepo.setAssignedAgent(created.id, agentId);
}

describe("AutoAssignAgentService (docs/spec/06_BACKEND_GAPS.md §2)", () => {
  it("elige al agente con menor carga activa del departamento", async () => {
    const { agentRepo, caseRepo, service } = build();
    const busy = agentRepo.seed({
      name: "Busy",
      email: "busy@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-1",
      autoAssignEnabled: true,
    });
    const free = agentRepo.seed({
      name: "Free",
      email: "free@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-1",
      autoAssignEnabled: true,
    });
    await seedHumanActiveCase(caseRepo, busy.id, "dept-1");
    await seedHumanActiveCase(caseRepo, busy.id, "dept-1");

    const chosen = await service.pickAgentForDepartment("dept-1");
    expect(chosen?.id).toBe(free.id);
  });

  it("desempata por nombre cuando la carga es igual", async () => {
    const { agentRepo, service } = build();
    agentRepo.seed({
      name: "Zulema",
      email: "z@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-1",
      autoAssignEnabled: true,
    });
    const ana = agentRepo.seed({
      name: "Ana",
      email: "a@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-1",
      autoAssignEnabled: true,
    });

    const chosen = await service.pickAgentForDepartment("dept-1");
    expect(chosen?.id).toBe(ana.id);
  });

  it("excluye agentes inactivos y con roles admin/manager fuera del pool operativo por defecto", async () => {
    const { agentRepo, service } = build();
    agentRepo.seed({
      name: "Inactivo",
      email: "i@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-1",
      active: false,
      autoAssignEnabled: true,
    });
    agentRepo.seed({
      name: "AdminX",
      email: "adm@isp.local",
      role: "admin",
      primaryDepartmentId: "dept-1",
      autoAssignEnabled: true,
    });
    const manager = agentRepo.seed({
      name: "Manager",
      email: "m@isp.local",
      role: "manager",
      primaryDepartmentId: "dept-1",
      autoAssignEnabled: true,
    });

    const chosen = await service.pickAgentForDepartment("dept-1");
    expect(chosen?.id).toBe(manager.id); // manager si es elegible, admin no
  });

  it("excluye a un agente que ya alcanzo el umbral de carga", async () => {
    const { agentRepo, caseRepo, service } = build(1);
    const overloaded = agentRepo.seed({
      name: "Ana",
      email: "ana@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-1",
      autoAssignEnabled: true,
    });
    await seedHumanActiveCase(caseRepo, overloaded.id, "dept-1");

    const chosen = await service.pickAgentForDepartment("dept-1");
    expect(chosen).toBeNull();
  });

  it("incluye agentes con membership explicita aunque su primaryDepartmentId sea otro", async () => {
    const { agentRepo, service } = build();
    const member = agentRepo.seed({
      name: "Ana",
      email: "ana@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-2",
      autoAssignEnabled: true,
    });
    await agentRepo.addMembership(member.id, "dept-1");

    const chosen = await service.pickAgentForDepartment("dept-1");
    expect(chosen?.id).toBe(member.id);
  });

  it("ignora agentes active del departamento con autoAssignEnabled=false", async () => {
    const { agentRepo, service } = build();
    agentRepo.seed({
      name: "Sin OptIn",
      email: "no@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-1",
      active: true,
      autoAssignEnabled: false,
    });
    const optedIn = agentRepo.seed({
      name: "Con OptIn",
      email: "yes@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-1",
      autoAssignEnabled: true,
    });

    const chosen = await service.pickAgentForDepartment("dept-1");
    expect(chosen?.id).toBe(optedIn.id);
  });

  it("devuelve null si solo hay agentes active sin autoAssignEnabled", async () => {
    const { agentRepo, service } = build();
    agentRepo.seed({
      name: "Ana",
      email: "ana@isp.local",
      role: "agent",
      primaryDepartmentId: "dept-1",
      active: true,
      autoAssignEnabled: false,
    });

    const chosen = await service.pickAgentForDepartment("dept-1");
    expect(chosen).toBeNull();
  });

  it("devuelve null si no hay ningun agente elegible en el departamento", async () => {
    const { service } = build();
    const chosen = await service.pickAgentForDepartment("dept-vacio");
    expect(chosen).toBeNull();
  });
});
