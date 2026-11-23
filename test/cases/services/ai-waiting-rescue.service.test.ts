import { describe, expect, it } from "vitest";
import { AiWaitingRescueService } from "../../../src/core/modules/cases/application/services/ai-waiting-rescue.service";
import { DepartmentResolverService } from "../../../src/core/modules/cases/application/services/department-resolver.service";
import { AutoAssignAgentService } from "../../../src/core/modules/escalation/application/services/auto-assign-agent.service";
import { CaseSummaryBuilderService } from "../../../src/core/modules/escalation/application/services/case-summary-builder.service";
import { EscalationService } from "../../../src/core/modules/escalation/application/services/escalation.service";
import { RealtimeBroadcaster } from "../../../src/core/modules/realtime/application/realtime-broadcaster";
import { EscalationRepositoryFake } from "../../../src/core/modules/escalation/infrastructure/postgres/escalation.repository.pg";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import {
  ConversationRepositoryFake,
  DepartmentRepositoryFake,
  MessageRepositoryFake,
} from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";
import { CaseRepositoryFake, WorkflowExecutionRepositoryFake } from "../fakes";

function buildHarness() {
  const caseRepo = new CaseRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const escalationRepo = new EscalationRepositoryFake();
  const executionRepo = new WorkflowExecutionRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const agentRepo = new AgentRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const messageRepo = new MessageRepositoryFake();
  const broadcaster = new RealtimeBroadcaster();

  const autoAssign = new AutoAssignAgentService({ agentRepo, caseRepo });
  const escalationService = new EscalationService({
    caseRepo,
    escalationRepo,
    workflowExecutionRepo: executionRepo,
    conversationRepo,
    departmentRepo,
    summaryBuilder: new CaseSummaryBuilderService(),
    logger: silentLogger,
    broadcaster,
    autoAssign,
    auditRepo,
  });
  const departmentResolver = new DepartmentResolverService(departmentRepo);

  const service = new AiWaitingRescueService({
    caseRepo,
    conversationRepo,
    escalationService,
    departmentResolver,
    departmentRepo,
    messageRepo,
    broadcaster,
    logger: silentLogger,
  });

  return {
    caseRepo,
    conversationRepo,
    escalationRepo,
    departmentRepo,
    agentRepo,
    messageRepo,
    service,
  };
}

describe("AiWaitingRescueService", () => {
  it("rescata caso WAITING_USER > 45 min, lo escala a su departamento, lo auto-asigna y registra nota interna sin escribir al cliente", async () => {
    const { caseRepo, conversationRepo, departmentRepo, agentRepo, messageRepo, service } =
      buildHarness();

    const billingDept = departmentRepo.seed({ slug: "facturacion", name: "Facturación" });
    const agent = agentRepo.seed({
      name: "Gabriela Mangia",
      email: "gabriela@isp.local",
      role: "agent",
      primaryDepartmentId: billingDept.id,
      autoAssignEnabled: true,
    });

    const conv = conversationRepo.createOpen({ status: "open" });
    const { case: created } = await caseRepo.create({
      conversationId: conv.id,
      workflowType: "BILLING_BALANCE",
      departmentId: billingDept.id,
      context: { workflowType: "BILLING_BALANCE", data: {} },
      initialState: "WAITING_USER_CLIENT",
      expiresAt: null,
    });
    const transitioned = await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "WAITING_USER",
      context: created.context,
      currentState: "WAITING_USER_CLIENT",
      expiresAt: null,
    });
    // Simular 50 minutos sin actividad
    transitioned.case.lastActivityAt = new Date(Date.now() - 50 * 60_000);

    const rescued = await service.rescueStaleCases(new Date());
    expect(rescued).toBe(1);

    const updated = await caseRepo.findById(created.id);
    expect(updated?.case.status).toBe("HUMAN_ACTIVE");
    expect(updated?.case.assignedAgentId).toBe(agent.id);

    const auto = await caseRepo.getAutomationState(created.id);
    expect(auto?.enabled).toBe(false);
    expect(auto?.disabledReason).toBe("AI_WAITING_TIMEOUT");

    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.author).toBe("system");
    expect(messages[0]!.body).toContain("Facturación");
  });

  it("rescata caso atascado en ACTIVE > 5 min y lo deja en cola ESCALATED si no hay asesores en turno", async () => {
    const { caseRepo, conversationRepo, departmentRepo, agentRepo, service } = buildHarness();

    const supportDept = departmentRepo.seed({ slug: "soporte", name: "Soporte Técnico" });
    // Asesor desconectado (autoAssignEnabled: false)
    agentRepo.seed({
      name: "Erick",
      email: "erick@isp.local",
      role: "agent",
      primaryDepartmentId: supportDept.id,
      autoAssignEnabled: false,
    });

    const conv = conversationRepo.createOpen({ status: "open" });
    const { case: created } = await caseRepo.create({
      conversationId: conv.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    const transitioned = await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: created.context,
      currentState: "DIAGNOSTIC",
      expiresAt: null,
    });
    transitioned.case.lastActivityAt = new Date(Date.now() - 8 * 60_000);

    const rescued = await service.rescueStaleCases(new Date());
    expect(rescued).toBe(1);

    const updated = await caseRepo.findById(created.id);
    expect(updated?.case.status).toBe("ESCALATED");
    expect(updated?.case.departmentId).toBe(supportDept.id);
    expect(updated?.case.assignedAgentId).toBeNull();

    const auto = await caseRepo.getAutomationState(created.id);
    expect(auto?.disabledReason).toBe("AI_STUCK_TIMEOUT");
  });

  it("no toca casos WAITING_USER recientes (< 45 min) ni conversaciones ya cerradas", async () => {
    const { caseRepo, conversationRepo, departmentRepo, service } = buildHarness();
    const billingDept = departmentRepo.seed({ slug: "facturacion", name: "Facturación" });

    // Caso reciente (20 min)
    const convRecent = conversationRepo.createOpen({ status: "open" });
    const { case: recent } = await caseRepo.create({
      conversationId: convRecent.id,
      workflowType: "BILLING_BALANCE",
      departmentId: billingDept.id,
      context: { workflowType: "BILLING_BALANCE", data: {} },
      initialState: "WAITING_USER_CLIENT",
      expiresAt: null,
    });
    const tRecent = await caseRepo.applyTransition({
      caseId: recent.id,
      expectedCaseVersion: recent.version,
      expectedWorkflowVersion: 1,
      status: "WAITING_USER",
      context: recent.context,
      currentState: "WAITING_USER_CLIENT",
      expiresAt: null,
    });
    tRecent.case.lastActivityAt = new Date(Date.now() - 20 * 60_000);

    // Caso viejo pero en conversación cerrada
    const convClosed = conversationRepo.createOpen({ status: "closed" });
    const { case: closedCase } = await caseRepo.create({
      conversationId: convClosed.id,
      workflowType: "BILLING_BALANCE",
      departmentId: billingDept.id,
      context: { workflowType: "BILLING_BALANCE", data: {} },
      initialState: "WAITING_USER_CLIENT",
      expiresAt: null,
    });
    const tClosed = await caseRepo.applyTransition({
      caseId: closedCase.id,
      expectedCaseVersion: closedCase.version,
      expectedWorkflowVersion: 1,
      status: "WAITING_USER",
      context: closedCase.context,
      currentState: "WAITING_USER_CLIENT",
      expiresAt: null,
    });
    tClosed.case.lastActivityAt = new Date(Date.now() - 120 * 60_000);

    const rescued = await service.rescueStaleCases(new Date());
    expect(rescued).toBe(0);
    expect((await caseRepo.findById(recent.id))?.case.status).toBe("WAITING_USER");
    expect((await caseRepo.findById(closedCase.id))?.case.status).toBe("WAITING_USER");
  });
});
