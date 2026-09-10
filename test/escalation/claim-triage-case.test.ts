import { describe, expect, it } from "vitest";
import { ClaimCaseUseCase } from "../../src/core/modules/escalation/application/use-cases/claim-case.use-case";
import { ReplyAsHumanUseCase } from "../../src/core/modules/conversations/application/use-cases/reply-as-human.use-case";
import { CaseRepositoryFake } from "../cases/fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../support/agent-audit.fakes";
import { EscalationRepositoryFake } from "../../src/core/modules/escalation/infrastructure/postgres/escalation.repository.pg";
import {
  ConversationRepositoryFake,
  DepartmentRepositoryFake,
  MessageRepositoryFake,
  WhatsAppSenderFake,
} from "../support/fakes";
import { silentLogger } from "../support/silent-logger";

function build() {
  const caseRepo = new CaseRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const messageRepo = new MessageRepositoryFake();
  const escalationRepo = new EscalationRepositoryFake();
  const agentRepo = new AgentRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const whatsappSender = new WhatsAppSenderFake();

  const claimCase = new ClaimCaseUseCase({
    caseRepo,
    escalationRepo,
    agentRepo,
    departmentRepo,
    auditRepo,
    logger: silentLogger,
  });

  const replyAsHuman = new ReplyAsHumanUseCase({
    conversationRepo,
    messageRepo,
    whatsappSender,
    auditRepo,
    logger: silentLogger,
    caseRepo,
    agentRepo,
    departmentRepo,
  });

  return {
    caseRepo,
    conversationRepo,
    escalationRepo,
    agentRepo,
    departmentRepo,
    claimCase,
    replyAsHuman,
  };
}

describe("Claim & Act on Triage Case by standard agent", () => {
  it("permite a un agente normal (role: 'agent') reclamar un caso del pool de triage (departmentId: null)", async () => {
    const { caseRepo, conversationRepo, escalationRepo, agentRepo, departmentRepo, claimCase } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const agent = agentRepo.seed({
      name: "Juan Agente",
      email: "juan@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
    });

    const conversation = conversationRepo.createOpen();
    const { case: triageCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "UNCLASSIFIED",
      departmentId: null, // pool de triage
      context: { workflowType: "UNCLASSIFIED", data: {} },
      initialState: "TRIAGE",
      expiresAt: null,
    });

    await escalationRepo.create({
      caseId: triageCase.id,
      departmentId: null,
      reason: "UNSUPPORTED",
      summary: {
        problem: "duda general",
        workflow: null,
        department: null,
        status: "ESCALATED",
        reason: "UNSUPPORTED",
        completedSteps: [],
        results: {},
        pendingAction: "TRIAGE",
        timeline: [],
      },
    });

    // El agente normal reclama el caso
    await claimCase.execute({
      caseId: triageCase.id,
      agentUserId: agent.id,
    });

    const claimed = await caseRepo.findById(triageCase.id);
    expect(claimed?.case.assignedAgentId).toBe(agent.id);
    expect(claimed?.case.departmentId).toBe(support.id);

    const escalation = await escalationRepo.findByCaseId(triageCase.id);
    expect(escalation?.assignedAgentId).toBe(agent.id);
    expect(escalation?.status).toBe("ASSIGNED");
    expect(escalation?.departmentId).toBe(support.id);
  });

  it("permite al agente asignado responder mensajes en la conversación reclamada de triage", async () => {
    const { caseRepo, conversationRepo, agentRepo, departmentRepo, claimCase, replyAsHuman } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const agent = agentRepo.seed({
      name: "Juan Agente",
      email: "juan@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
    });

    const conversation = conversationRepo.createOpen();
    const { case: triageCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "UNCLASSIFIED",
      departmentId: null,
      context: { workflowType: "UNCLASSIFIED", data: {} },
      initialState: "TRIAGE",
      expiresAt: null,
    });

    await claimCase.execute({
      caseId: triageCase.id,
      agentUserId: agent.id,
    });

    // El agente asignado envía respuesta
    const message = await replyAsHuman.execute({
      conversationId: conversation.id,
      agentUserId: agent.id,
      body: "Hola, te ayudo con tu consulta",
    });

    expect(message.author).toBe("agent");
    expect(message.body).toBe("Hola, te ayudo con tu consulta");
  });
});
