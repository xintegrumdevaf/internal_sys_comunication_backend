import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { RealtimeBroadcaster } from "../../src/core/modules/realtime/application/realtime-broadcaster";
import { createRealtimeRouter } from "../../src/core/modules/realtime/presentation/realtime.router";
import { createConversationsRouter } from "../../src/core/modules/conversations/presentation/conversations.router";
import { createCasesRouter } from "../../src/core/modules/cases/presentation/cases.router";
import { ListConversationsUseCase } from "../../src/core/modules/conversations/application/use-cases/list-conversations.use-case";
import { ListMessagesUseCase } from "../../src/core/modules/conversations/application/use-cases/list-messages.use-case";
import { ReplyAsHumanUseCase } from "../../src/core/modules/conversations/application/use-cases/reply-as-human.use-case";
import { TakeControlUseCase } from "../../src/core/modules/conversations/application/use-cases/take-control.use-case";
import { CompleteCaseUseCase } from "../../src/core/modules/cases/application/use-cases/complete-case.use-case";
import { TransferCaseUseCase } from "../../src/core/modules/cases/application/use-cases/transfer-case.use-case";
import { CancelCaseUseCase } from "../../src/core/modules/cases/application/use-cases/cancel-case.use-case";
import { GetDashboardUseCase } from "../../src/core/modules/cases/application/use-cases/get-dashboard.use-case";
import { ClaimCaseUseCase } from "../../src/core/modules/escalation/application/use-cases/claim-case.use-case";
import { AssignCaseUseCase } from "../../src/core/modules/escalation/application/use-cases/assign-case.use-case";
import {
  DisableAutomationUseCase,
  ReactivateAutomationUseCase,
} from "../../src/core/modules/escalation/application/use-cases/disable-automation.use-case";
import { GetCaseSummaryUseCase } from "../../src/core/modules/escalation/application/use-cases/list-escalations.use-case";
import { CaseSummaryBuilderService } from "../../src/core/modules/escalation/application/services/case-summary-builder.service";
import { EscalationRepositoryFake } from "../../src/core/modules/escalation/infrastructure/postgres/escalation.repository.pg";
import { CaseRepositoryFake, WorkflowExecutionRepositoryFake } from "../cases/fakes";
import {
  ConversationRepositoryFake,
  DepartmentRepositoryFake,
  MessageRepositoryFake,
  WhatsAppSenderFake,
} from "../support/fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../support/agent-audit.fakes";
import { silentLogger } from "../support/silent-logger";
import { createErrorHandler } from "../../src/shared/http/middlewares/error-handler.middleware";

describe("Etapa 7 aceptacion (docs/spec/05_BUILD_PLAN.md)", () => {
  it("lista conversaciones con lastMessagePreview y filtros", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const caseRepo = new CaseRepositoryFake();
    const conv = conversationRepo.createOpen();
    messageRepo.seedText(conv.id, "hola cliente");
    const list = new ListConversationsUseCase(conversationRepo, messageRepo, caseRepo);
    const data = await list.execute({});
    expect(data).toHaveLength(1);
    expect(data[0]!.lastMessagePreview?.body).toBe("hola cliente");
    expect(data[0]!.lastMessagePreview?.author).toBe("customer");
  });

  it("SSE publica MESSAGE_SENT y CASE_CLAIMED a suscriptores", async () => {
    const broadcaster = new RealtimeBroadcaster();
    const received: unknown[] = [];
    const unsub = broadcaster.subscribe({
      userId: "u1",
      departmentIds: new Set(),
      role: "agent",
      send: (e) => received.push(e),
    });

    broadcaster.publish({
      type: "MESSAGE_SENT",
      conversationId: "c1",
      messageId: "m1",
      author: "ai",
    });
    broadcaster.publish({
      type: "CASE_CLAIMED",
      caseId: "case1",
      agentUserId: "agent1",
    });

    expect(received).toEqual([
      { type: "MESSAGE_SENT", conversationId: "c1", messageId: "m1", author: "ai" },
      { type: "CASE_CLAIMED", caseId: "case1", agentUserId: "agent1" },
    ]);
    unsub();
  });

  it("endpoints §C: cases/timeline, complete, cancel, transfer, dashboard, take-control", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const caseRepo = new CaseRepositoryFake();
    const departmentRepo = new DepartmentRepositoryFake();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const billing = departmentRepo.seed({ slug: "billing", name: "Facturacion" });
    const agentRepo = new AgentRepositoryFake();
    const agent = agentRepo.seed({
      name: "Agente",
      email: "a@t.com",
      role: "agent",
      primaryDepartmentId: support.id,
    });
    await agentRepo.addMembership(agent.id, support.id);
    const auditRepo = new AuditRepositoryFake();
    const escalationRepo = new EscalationRepositoryFake();
    const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
    const broadcaster = new RealtimeBroadcaster();
    const whatsappSender = new WhatsAppSenderFake();

    const conversation = conversationRepo.createOpen();
    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
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
      status: "WAITING_USER",
      context: created.context,
      currentState: "WAITING_USER_CLIENT",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, created.id);
    await caseRepo.setAssignedAgent(created.id, agent.id);

    const claimCase = new ClaimCaseUseCase({
      caseRepo,
      escalationRepo,
      agentRepo,
      departmentRepo,
      auditRepo,
      logger: silentLogger,
    });
    const assignCase = new AssignCaseUseCase({
      caseRepo,
      escalationRepo,
      agentRepo,
      departmentRepo,
      auditRepo,
      logger: silentLogger,
    });
    const disableAutomation = new DisableAutomationUseCase({
      caseRepo,
      agentRepo,
      departmentRepo,
      auditRepo,
      logger: silentLogger,
    });
    const reactivateAutomation = new ReactivateAutomationUseCase({
      caseRepo,
      agentRepo,
      departmentRepo,
      auditRepo,
      logger: silentLogger,
    });
    const getCaseSummary = new GetCaseSummaryUseCase({
      caseRepo,
      escalationRepo,
      workflowExecutionRepo,
      departmentRepo,
      summaryBuilder: new CaseSummaryBuilderService(),
    });
    const completeCase = new CompleteCaseUseCase({
      caseRepo,
      conversationRepo,
      auditRepo,
      logger: silentLogger,
    });
    const cancelCase = new CancelCaseUseCase({ caseRepo, conversationRepo, logger: silentLogger });
    const transferCase = new TransferCaseUseCase({
      caseRepo,
      departmentRepo,
      auditRepo,
      logger: silentLogger,
    });
    const getDashboard = new GetDashboardUseCase({
      conversationRepo,
      caseRepo,
      agentRepo,
      escalationRepo,
    });
    const takeControl = new TakeControlUseCase({
      conversationRepo,
      caseRepo,
      claimCase,
      logger: silentLogger,
      broadcaster,
    });
    const listConversations = new ListConversationsUseCase(conversationRepo, messageRepo, caseRepo);
    const listMessages = new ListMessagesUseCase(conversationRepo, messageRepo);
    const replyAsHuman = new ReplyAsHumanUseCase({
      conversationRepo,
      messageRepo,
      whatsappSender,
      auditRepo,
      logger: silentLogger,
      caseRepo,
    });

    const app = express();
    app.use(express.json());
    app.use(
      createConversationsRouter({
        listConversations,
        listMessages,
        replyAsHuman,
        takeControl,
        caseRepo,
        broadcaster,
      }),
    );
    app.use(
      createCasesRouter({
        caseRepo,
        workflowExecutionRepo,
        claimCase,
        assignCase,
        disableAutomation,
        reactivateAutomation,
        getCaseSummary,
        completeCase,
        cancelCase,
        transferCase,
        getDashboard,
        broadcaster,
      }),
    );
    app.use(createRealtimeRouter({ broadcaster, agentRepo }));
    app.use(createErrorHandler(silentLogger));

    const casesRes = await request(app).get(`/api/conversations/${conversation.id}/cases`);
    expect(casesRes.status).toBe(200);
    expect(casesRes.body.data).toHaveLength(1);

    const autoRes = await request(app).get(`/api/conversations/${conversation.id}/automation`);
    expect(autoRes.status).toBe(200);
    expect(autoRes.body.data.caseId).toBe(created.id);

    const timelineRes = await request(app).get(`/api/cases/${created.id}/timeline`);
    expect(timelineRes.status).toBe(200);
    expect(Array.isArray(timelineRes.body.data)).toBe(true);

    const dashRes = await request(app)
      .get("/api/dashboard")
      .set("x-agent-id", agent.id)
      .query({ userId: agent.id });
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.data.openConversations).toBeGreaterThanOrEqual(1);

    const transferRes = await request(app)
      .post(`/api/cases/${created.id}/transfer`)
      .set("x-agent-id", agent.id)
      .send({ toDepartmentId: billing.id, reason: "cliente pregunta saldo" });
    expect(transferRes.status).toBe(200);
    expect(transferRes.body.data.departmentId).toBe(billing.id);

    // Reasignar para poder completar (transfer liberó assignedAgent)
    await caseRepo.setAssignedAgent(created.id, agent.id);
    const afterTransfer = await caseRepo.findById(created.id);
    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: afterTransfer!.case.version,
      expectedWorkflowVersion: afterTransfer!.workflowInstance.version,
      status: "HUMAN_ACTIVE",
      context: afterTransfer!.case.context,
      currentState: afterTransfer!.workflowInstance.currentState,
      departmentId: billing.id,
      expiresAt: null,
    });

    const completeRes = await request(app)
      .post(`/api/cases/${created.id}/complete`)
      .set("x-agent-id", agent.id)
      .send({ resolutionNote: "resuelto" });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.data.status).toBe("COMPLETED");

    // Nuevo caso para cancel
    const { case: other } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: other.id,
      expectedCaseVersion: other.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: other.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    const cancelRes = await request(app)
      .post(`/api/cases/${other.id}/cancel`)
      .send({ reason: "spam" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe("CANCELLED");
  });
});
