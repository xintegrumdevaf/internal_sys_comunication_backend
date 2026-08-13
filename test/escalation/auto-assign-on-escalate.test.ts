import { describe, expect, it } from "vitest";
import { EscalationService } from "../../src/core/modules/escalation/application/services/escalation.service";
import { AutoAssignAgentService } from "../../src/core/modules/escalation/application/services/auto-assign-agent.service";
import { CaseSummaryBuilderService } from "../../src/core/modules/escalation/application/services/case-summary-builder.service";
import { RealtimeBroadcaster } from "../../src/core/modules/realtime/application/realtime-broadcaster";
import { CaseRepositoryFake, WorkflowExecutionRepositoryFake } from "../cases/fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../support/agent-audit.fakes";
import { ConversationRepositoryFake, DepartmentRepositoryFake } from "../support/fakes";
import { EscalationRepositoryFake } from "../../src/core/modules/escalation/infrastructure/postgres/escalation.repository.pg";
import { silentLogger } from "../support/silent-logger";

function buildStack(maxActiveCasesPerAgent = 6) {
  const caseRepo = new CaseRepositoryFake();
  const escalationRepo = new EscalationRepositoryFake();
  const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const agentRepo = new AgentRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const broadcaster = new RealtimeBroadcaster();
  const autoAssign = new AutoAssignAgentService({ agentRepo, caseRepo, maxActiveCasesPerAgent });

  const escalationService = new EscalationService({
    caseRepo,
    escalationRepo,
    workflowExecutionRepo,
    conversationRepo,
    departmentRepo,
    summaryBuilder: new CaseSummaryBuilderService(),
    logger: silentLogger,
    broadcaster,
    autoAssign,
    auditRepo,
  });

  return { caseRepo, escalationRepo, departmentRepo, agentRepo, auditRepo, broadcaster, escalationService };
}

describe("Auto-asignacion al escalar (docs/spec/06_BACKEND_GAPS.md §2)", () => {
  it("asigna automaticamente el caso al agente disponible del departamento y pasa a HUMAN_ACTIVE", async () => {
    const { caseRepo, departmentRepo, agentRepo, auditRepo, broadcaster, escalationService } = buildStack();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const agent = agentRepo.seed({
      name: "Ana",
      email: "ana@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      autoAssignEnabled: true,
    });
    const conversation = { id: "conv-1" };
    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const received: unknown[] = [];
    broadcaster.subscribe({ userId: agent.id, departmentIds: new Set([support.id]), role: "agent", send: (e) => received.push(e) });

    const { case: escalated, escalation } = await escalationService.escalateExistingCase({
      caseId: created.id,
      reason: "REQUEST_HUMAN",
      correlationId: "corr-1",
    });

    expect(escalated.status).toBe("HUMAN_ACTIVE");
    expect(escalated.assignedAgentId).toBe(agent.id);
    expect(escalation.status).toBe("ASSIGNED");
    expect(escalation.assignedAgentId).toBe(agent.id);

    expect(auditRepo.events).toContainEqual(
      expect.objectContaining({ action: "CASE_AUTO_ASSIGNED", resourceId: created.id, actorId: null }),
    );
    expect(received).toContainEqual(
      expect.objectContaining({ type: "HUMAN_ASSIGNED", caseId: created.id, agentUserId: agent.id }),
    );
  });

  it("deja el caso ESCALATED y sin asignar si no hay agentes disponibles en el departamento", async () => {
    const { departmentRepo, caseRepo, escalationService } = buildStack();
    const billing = departmentRepo.seed({ slug: "billing", name: "Facturacion" });
    const { case: created } = await caseRepo.create({
      conversationId: "conv-2",
      workflowType: "BILLING_BALANCE",
      departmentId: billing.id,
      context: { workflowType: "BILLING_BALANCE", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const { case: escalated, escalation } = await escalationService.escalateExistingCase({
      caseId: created.id,
      reason: "REQUEST_HUMAN",
      correlationId: "corr-2",
    });

    expect(escalated.status).toBe("ESCALATED");
    expect(escalated.assignedAgentId).toBeNull();
    expect(escalation.status).toBe("PENDING");
  });

  it("nunca auto-asigna el pool de triage (departmentId null)", async () => {
    const { escalationService, agentRepo, departmentRepo } = buildStack();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent", primaryDepartmentId: support.id });

    const { case: triaged, escalation } = await escalationService.sendToTriage({
      conversationId: "conv-3",
      reason: "UNSUPPORTED:UNKNOWN",
      correlationId: "corr-3",
    });

    expect(triaged.departmentId).toBeNull();
    expect(triaged.assignedAgentId).toBeNull();
    expect(escalation.status).toBe("PENDING");
  });

  it("respeta el umbral de carga: no fuerza la asignacion a un agente sobrecargado", async () => {
    const { caseRepo, departmentRepo, agentRepo, escalationService } = buildStack(1);
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const agent = agentRepo.seed({
      name: "Ana",
      email: "ana@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      autoAssignEnabled: true,
    });

    // Ya tiene 1 caso activo -> alcanza el umbral de 1
    const { case: existing } = await caseRepo.create({
      conversationId: "conv-prev",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: existing.id,
      expectedCaseVersion: existing.version,
      expectedWorkflowVersion: 1,
      status: "HUMAN_ACTIVE",
      context: existing.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.setAssignedAgent(existing.id, agent.id);

    const { case: created } = await caseRepo.create({
      conversationId: "conv-4",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    const { case: escalated } = await escalationService.escalateExistingCase({
      caseId: created.id,
      reason: "REQUEST_HUMAN",
      correlationId: "corr-4",
    });

    expect(escalated.assignedAgentId).toBeNull();
    expect(escalated.status).toBe("ESCALATED");
  });
});
