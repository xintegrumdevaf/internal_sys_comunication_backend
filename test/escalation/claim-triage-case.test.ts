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

  it("adopta automáticamente el departamento del asesor (ej: Facturación) cuando reclama un caso en General", async () => {
    const { caseRepo, conversationRepo, escalationRepo, agentRepo, departmentRepo, claimCase } = build();
    const general = departmentRepo.seed({ slug: "general", name: "General" });
    const billing = departmentRepo.seed({ slug: "facturacion", name: "Facturación" });

    const emilie = agentRepo.seed({
      name: "Emilie Matiz",
      email: "emilie@isp.local",
      role: "agent",
      primaryDepartmentId: billing.id,
    });

    const conversation = conversationRepo.createOpen();
    const { case: generalCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "GENERAL_INQUIRY",
      departmentId: general.id, // caso en pool general
      context: { workflowType: "GENERAL_INQUIRY", data: {} },
      initialState: "TRIAGE",
      expiresAt: null,
    });

    await escalationRepo.create({
      caseId: generalCase.id,
      departmentId: general.id,
      reason: "FALLBACK_GENERAL",
      summary: {
        problem: "consulta general",
        workflow: null,
        department: "General",
        status: "ESCALATED",
        reason: "FALLBACK_GENERAL",
        completedSteps: [],
        results: {},
        pendingAction: "TRIAGE",
        timeline: [],
      },
    });

    // Emilie de Facturación reclama el caso que estaba en General
    await claimCase.execute({
      caseId: generalCase.id,
      agentUserId: emilie.id,
    });

    const claimed = await caseRepo.findById(generalCase.id);
    expect(claimed?.case.assignedAgentId).toBe(emilie.id);
    // El caso debe haber adoptado el departamento de Emilie (Facturación)
    expect(claimed?.case.departmentId).toBe(billing.id);

    const escalation = await escalationRepo.findByCaseId(generalCase.id);
    expect(escalation?.assignedAgentId).toBe(emilie.id);
    expect(escalation?.status).toBe("ASSIGNED");
    expect(escalation?.departmentId).toBe(billing.id);
  });

  it("adopta automáticamente el departamento del asesor al responder si el caso seguía en General", async () => {
    const { caseRepo, conversationRepo, agentRepo, departmentRepo, replyAsHuman } = build();
    const general = departmentRepo.seed({ slug: "general", name: "General" });
    const billing = departmentRepo.seed({ slug: "facturacion", name: "Facturación" });

    const emilie = agentRepo.seed({
      name: "Emilie Matiz",
      email: "emilie@isp.local",
      role: "agent",
      primaryDepartmentId: billing.id,
    });

    const conversation = conversationRepo.createOpen();
    const { case: generalCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "GENERAL_INQUIRY",
      departmentId: general.id,
      context: { workflowType: "GENERAL_INQUIRY", data: {} },
      initialState: "HUMAN_ACTIVE",
      expiresAt: null,
    });

    // Simulamos que ya estaba asignado a Emilie pero aún tenía departmentId: general
    await caseRepo.setAssignedAgent(generalCase.id, emilie.id);
    await conversationRepo.setActiveCaseId(conversation.id, generalCase.id);

    // Emilie responde
    await replyAsHuman.execute({
      conversationId: conversation.id,
      agentUserId: emilie.id,
      body: "Entiendo, yo me encargo de tu factura.",
    });

    const afterReply = await caseRepo.findById(generalCase.id);
    expect(afterReply?.case.departmentId).toBe(billing.id);
  });

  it("mantiene el departamento especializado si el caso ya pertenecía a otro departamento no-general", async () => {
    const { caseRepo, conversationRepo, escalationRepo, agentRepo, departmentRepo, claimCase } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const billing = departmentRepo.seed({ slug: "facturacion", name: "Facturación" });

    const emilie = agentRepo.seed({
      name: "Emilie Matiz",
      email: "emilie@isp.local",
      role: "agent",
      primaryDepartmentId: billing.id,
    });

    const conversation = conversationRepo.createOpen();
    const { case: supportCase } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id, // departamento específico de soporte
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "ESCALATED",
      expiresAt: null,
    });

    await escalationRepo.create({
      caseId: supportCase.id,
      departmentId: support.id,
      reason: "TECH_ISSUE",
      summary: {
        problem: "soporte técnico",
        workflow: "SUPPORT_INTERNET",
        department: "Soporte",
        status: "ESCALATED",
        reason: "TECH_ISSUE",
        completedSteps: [],
        results: {},
        pendingAction: "SUPPORT",
        timeline: [],
      },
    });

    await claimCase.execute({
      caseId: supportCase.id,
      agentUserId: emilie.id,
    });

    const claimed = await caseRepo.findById(supportCase.id);
    expect(claimed?.case.assignedAgentId).toBe(emilie.id);
    // Debe mantener Soporte porque NO era General ni triage
    expect(claimed?.case.departmentId).toBe(support.id);
  });
});
