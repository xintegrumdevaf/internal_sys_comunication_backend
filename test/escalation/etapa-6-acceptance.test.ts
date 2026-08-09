import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/shared/errors/domain-errors";
import { EscalationService } from "../../src/core/modules/escalation/application/services/escalation.service";
import { CaseSummaryBuilderService } from "../../src/core/modules/escalation/application/services/case-summary-builder.service";
import { ClaimCaseUseCase } from "../../src/core/modules/escalation/application/use-cases/claim-case.use-case";
import { AssignCaseUseCase } from "../../src/core/modules/escalation/application/use-cases/assign-case.use-case";
import { ReactivateAutomationUseCase } from "../../src/core/modules/escalation/application/use-cases/reactivate-automation.use-case";
import { ListEscalationsUseCase } from "../../src/core/modules/escalation/application/use-cases/list-escalations.use-case";
import { EscalationRepositoryFake } from "../../src/core/modules/escalation/infrastructure/postgres/escalation.repository.pg";
import { ProcessBufferedMessagesUseCase } from "../../src/core/modules/cases/application/use-cases/process-buffered-messages.use-case";
import { AdvanceCaseUseCase } from "../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { CaseArbitrationService } from "../../src/core/modules/cases/application/services/case-arbitration.service";
import { DepartmentResolverService } from "../../src/core/modules/cases/application/services/department-resolver.service";
import { WorkflowEngine } from "../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import { ComposeCustomerReplyUseCase } from "../../src/core/modules/ai/application/use-cases/compose-customer-reply.use-case";
import { TranscribeAudioUseCase } from "../../src/core/modules/ai/application/use-cases/transcribe-audio.use-case";
import { ExtractReceiptDataUseCase } from "../../src/core/modules/ai/application/use-cases/extract-receipt-data.use-case";
import { FakeAIProvider } from "../../src/core/modules/ai/infrastructure/fake/fake-ai.provider";
import { AiInterpretationAdapter } from "../../src/core/modules/cases/infrastructure/ai/ai-interpretation.adapter";
import { CaseRepositoryFake, N8nGatewayFake, WorkflowExecutionRepositoryFake } from "../cases/fakes";
import {
  ConversationRepositoryFake,
  DepartmentRepositoryFake,
  MessageRepositoryFake,
  WhatsAppSenderFake,
} from "../support/fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../support/agent-audit.fakes";
import { silentLogger } from "../support/silent-logger";

function buildEscalationStack() {
  const caseRepo = new CaseRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
  const agentRepo = new AgentRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const escalationRepo = new EscalationRepositoryFake();
  const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
  const summaryBuilder = new CaseSummaryBuilderService();
  const escalationService = new EscalationService({
    caseRepo,
    escalationRepo,
    workflowExecutionRepo,
    conversationRepo,
    departmentRepo,
    summaryBuilder,
    logger: silentLogger,
  });
  return {
    caseRepo,
    conversationRepo,
    departmentRepo,
    support,
    agentRepo,
    auditRepo,
    escalationRepo,
    workflowExecutionRepo,
    escalationService,
  };
}

describe("Etapa 6 aceptacion (docs/spec/05_BUILD_PLAN.md)", () => {
  it("error tecnico no recuperable escala con resumen y automation off", async () => {
    const stack = buildEscalationStack();
    const conversation = stack.conversationRepo.createOpen();
    const { case: created } = await stack.caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: stack.support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await stack.caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: created.context,
      currentState: "DIAGNOSTIC",
      expiresAt: null,
    });

    await stack.workflowExecutionRepo.start({
      workflowInstanceId: (await stack.caseRepo.findById(created.id))!.workflowInstance.id,
      caseId: created.id,
      action: "DIAGNOSTIC",
      input: {},
      idempotencyKey: "k1",
      correlationId: "c1",
    });
    await stack.workflowExecutionRepo.fail({
      idempotencyKey: "k1",
      error: { type: "TIMEOUT", message: "n8n timeout", retryable: false },
    });

    const { case: escalated, escalation, customerMessage } =
      await stack.escalationService.escalateExistingCase({
        caseId: created.id,
        reason: "TIMEOUT",
      });

    expect(escalated.status).toBe("ESCALATED");
    expect((await stack.caseRepo.getAutomationState(created.id))?.enabled).toBe(false);
    expect(escalation.summary.reason).toBe("TIMEOUT");
    expect(escalation.summary.timeline.some((t) => t.action === "DIAGNOSTIC")).toBe(true);
    expect(customerMessage.toLowerCase()).not.toContain("timeout");
    expect(customerMessage.toLowerCase()).not.toContain("n8n");
  });

  it("workflow no soportado cae en triage sin departamento", async () => {
    const stack = buildEscalationStack();
    const messageRepo = new MessageRepositoryFake();
    const whatsappSender = new WhatsAppSenderFake();
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const fakeAi = new FakeAIProvider();
    fakeAi.interpretImpl = async () => ({
      type: "NEW_INTENT",
      intent: "general.inquiry",
      entities: {},
      confidence: 0.95,
    });
    const conversation = stack.conversationRepo.createOpen();

    const useCase = new ProcessBufferedMessagesUseCase({
      caseRepo: stack.caseRepo,
      conversationRepo: stack.conversationRepo,
      messageRepo,
      whatsappSender,
      departmentResolver: new DepartmentResolverService(stack.departmentRepo),
      arbitrationService: new CaseArbitrationService(stack.caseRepo, silentLogger),
      interpretationProvider: new AiInterpretationAdapter(fakeAi, silentLogger),
      engine,
      advanceCase: new AdvanceCaseUseCase({
        caseRepo: stack.caseRepo,
        workflowExecutionRepo: stack.workflowExecutionRepo,
        conversationRepo: stack.conversationRepo,
        engine,
        gateway: new N8nGatewayFake({}),
        logger: silentLogger,
        escalationService: stack.escalationService,
      }),
      composeReply: new ComposeCustomerReplyUseCase(fakeAi),
      transcribeAudio: new TranscribeAudioUseCase(fakeAi),
      extractReceiptData: new ExtractReceiptDataUseCase(fakeAi),
      logger: silentLogger,
      escalationService: stack.escalationService,
    });

    await useCase.execute({
      conversationId: conversation.id,
      correlationId: "corr-triage",
      messages: [messageRepo.seedText(conversation.id, "qué horarios tienen?")],
    });

    const cases = await stack.caseRepo.listByConversation(conversation.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.workflowType).toBe("UNCLASSIFIED");
    expect(cases[0]!.departmentId).toBeNull();
    expect(cases[0]!.status).toBe("ESCALATED");
    const escalations = await stack.escalationRepo.list({ triage: true });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.departmentId).toBeNull();
    expect(whatsappSender.sent[0]!.body.toLowerCase()).toContain("asesor");
  });

  it("manager (no solo admin) ve el pool de triage y puede clasificarlo", async () => {
    const stack = buildEscalationStack();
    const manager = stack.agentRepo.seed({
      name: "Mgr",
      email: "mgr@test.com",
      role: "manager",
      primaryDepartmentId: stack.support.id,
    });
    const agent = stack.agentRepo.seed({
      name: "Agente",
      email: "ag@test.com",
      role: "agent",
      primaryDepartmentId: stack.support.id,
    });
    await stack.agentRepo.addMembership(manager.id, stack.support.id);

    const { case: triageCase } = await stack.escalationService.sendToTriage({
      conversationId: stack.conversationRepo.createOpen().id,
      reason: "UNSUPPORTED:FOO",
      correlationId: "c",
    });

    const list = new ListEscalationsUseCase({
      escalationRepo: stack.escalationRepo,
      agentRepo: stack.agentRepo,
      departmentRepo: stack.departmentRepo,
    });
    const visible = await list.execute({ agentUserId: manager.id, triage: true });
    expect(visible).toHaveLength(1);

    await expect(
      list.execute({ agentUserId: agent.id, triage: true }),
    ).rejects.toBeInstanceOf(DomainError);

    const assign = new AssignCaseUseCase({
      caseRepo: stack.caseRepo,
      escalationRepo: stack.escalationRepo,
      agentRepo: stack.agentRepo,
      departmentRepo: stack.departmentRepo,
      auditRepo: stack.auditRepo,
      logger: silentLogger,
    });
    await assign.execute({
      caseId: triageCase.id,
      actorAgentId: manager.id,
      agentUserId: agent.id,
      departmentId: stack.support.id,
    });

    const after = await stack.caseRepo.findById(triageCase.id);
    expect(after?.case.departmentId).toBe(stack.support.id);
    expect(after?.case.assignedAgentId).toBe(agent.id);
    expect(after?.case.status).toBe("HUMAN_ACTIVE");
  });

  it("agente puede claim un caso libre pero no actuar sobre uno de otro", async () => {
    const stack = buildEscalationStack();
    const agentA = stack.agentRepo.seed({ name: "A", email: "a@t.com", role: "agent" });
    const agentB = stack.agentRepo.seed({ name: "B", email: "b@t.com", role: "agent" });
    await stack.agentRepo.addMembership(agentA.id, stack.support.id);
    await stack.agentRepo.addMembership(agentB.id, stack.support.id);

    const conversation = stack.conversationRepo.createOpen();
    const { case: created } = await stack.caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: stack.support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: { client: { nationalId: "1", fullName: "X" } } },
      initialState: "DIAGNOSTIC",
      expiresAt: null,
    });
    await stack.caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "ESCALATED",
      context: created.context,
      currentState: "DIAGNOSTIC",
      expiresAt: null,
    });
    await stack.escalationService.ensureEscalationRecord({
      caseId: created.id,
      reason: "TECHNICAL",
    });

    const claim = new ClaimCaseUseCase({
      caseRepo: stack.caseRepo,
      escalationRepo: stack.escalationRepo,
      agentRepo: stack.agentRepo,
      departmentRepo: stack.departmentRepo,
      auditRepo: stack.auditRepo,
      logger: silentLogger,
    });
    await claim.execute({ caseId: created.id, agentUserId: agentA.id });
    expect((await stack.caseRepo.findById(created.id))?.case.assignedAgentId).toBe(agentA.id);

    await expect(claim.execute({ caseId: created.id, agentUserId: agentB.id })).rejects.toBeInstanceOf(
      DomainError,
    );

    const reactivate = new ReactivateAutomationUseCase({
      caseRepo: stack.caseRepo,
      agentRepo: stack.agentRepo,
      departmentRepo: stack.departmentRepo,
      auditRepo: stack.auditRepo,
      logger: silentLogger,
    });
    await expect(
      reactivate.execute({ caseId: created.id, agentUserId: agentB.id }),
    ).rejects.toMatchObject({ type: "AUTHORIZATION_ERROR" });
  });

  it("reactivar automatizacion conserva context y no reinicia el workflow", async () => {
    const stack = buildEscalationStack();
    const agent = stack.agentRepo.seed({
      name: "A",
      email: "a@t.com",
      role: "agent",
      primaryDepartmentId: stack.support.id,
    });
    await stack.agentRepo.addMembership(agent.id, stack.support.id);

    const conversation = stack.conversationRepo.createOpen();
    const context = {
      workflowType: "SUPPORT_INTERNET" as const,
      data: {
        client: { nationalId: "99", fullName: "Ana" },
        diagnostic: { status: "WAITING_USER", lastQuestion: "¿ONU roja?" },
      },
    };
    const { case: created } = await stack.caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: stack.support.id,
      context,
      initialState: "WAITING_USER_DIAGNOSTIC",
      expiresAt: null,
    });
    let aggregate = await stack.caseRepo.findById(created.id);
    await stack.caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: aggregate!.case.version,
      expectedWorkflowVersion: aggregate!.workflowInstance.version,
      status: "HUMAN_ACTIVE",
      context,
      currentState: "WAITING_USER_DIAGNOSTIC",
      expiresAt: null,
    });
    await stack.caseRepo.setAssignedAgent(created.id, agent.id);
    await stack.caseRepo.setAutomationEnabled(created.id, false, { reason: "HUMAN" });

    const before = await stack.caseRepo.findById(created.id);
    const reactivate = new ReactivateAutomationUseCase({
      caseRepo: stack.caseRepo,
      agentRepo: stack.agentRepo,
      departmentRepo: stack.departmentRepo,
      auditRepo: stack.auditRepo,
      logger: silentLogger,
    });
    const result = await reactivate.execute({ caseId: created.id, agentUserId: agent.id });

    const after = await stack.caseRepo.findById(created.id);
    expect(result.automation.enabled).toBe(true);
    expect(result.contextPreserved).toBe(true);
    expect(after?.case.context).toEqual(before?.case.context);
    expect(after?.workflowInstance.currentState).toBe("WAITING_USER_DIAGNOSTIC");
    expect(after?.case.status).toBe("HUMAN_ACTIVE");
  });
});
