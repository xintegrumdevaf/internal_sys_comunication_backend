import { describe, expect, it } from "vitest";
import { CompleteCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/complete-case.use-case";
import { CaseRepositoryFake } from "../fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import { ConversationRepositoryFake, DepartmentRepositoryFake } from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

function build() {
  const caseRepo = new CaseRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const agentRepo = new AgentRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const useCase = new CompleteCaseUseCase({ caseRepo, conversationRepo, auditRepo, logger: silentLogger, agentRepo, departmentRepo });
  return { caseRepo, agentRepo, departmentRepo, useCase };
}

async function seedHumanActiveCase(caseRepo: CaseRepositoryFake, departmentId: string, assignedAgentId: string) {
  const { case: created } = await caseRepo.create({
    conversationId: "conv-1",
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
  await caseRepo.setAssignedAgent(created.id, assignedAgentId);
  return created.id;
}

describe("CompleteCaseUseCase — solo lectura para agentes no asignados (docs/spec/06_BACKEND_GAPS.md §2)", () => {
  it("el agente asignado si puede completar su propio caso", async () => {
    const { caseRepo, agentRepo, departmentRepo, useCase } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const owner = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent", primaryDepartmentId: support.id });
    const caseId = await seedHumanActiveCase(caseRepo, support.id, owner.id);

    const result = await useCase.execute({ caseId, agentUserId: owner.id });
    expect(result.status).toBe("COMPLETED");
  });

  it("otro agente (no asignado) no puede completar el caso", async () => {
    const { caseRepo, agentRepo, departmentRepo, useCase } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const owner = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent", primaryDepartmentId: support.id });
    const other = agentRepo.seed({ name: "Beto", email: "beto@isp.local", role: "agent", primaryDepartmentId: support.id });
    const caseId = await seedHumanActiveCase(caseRepo, support.id, owner.id);

    await expect(useCase.execute({ caseId, agentUserId: other.id })).rejects.toMatchObject({
      type: "AUTHORIZATION_ERROR",
    });
  });

  it("un caso ACTIVE (bot, sin escalar) puede completarse por cualquier agente autenticado", async () => {
    const { caseRepo, agentRepo, departmentRepo, useCase } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const anyAgent = agentRepo.seed({ name: "Cualquiera", email: "a@isp.local", role: "agent", primaryDepartmentId: support.id });
    const { case: created } = await caseRepo.create({
      conversationId: "conv-2",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const result = await useCase.execute({ caseId: created.id, agentUserId: anyAgent.id });
    expect(result.status).toBe("COMPLETED");
  });
});
