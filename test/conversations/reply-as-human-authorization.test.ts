import { describe, expect, it } from "vitest";
import { ReplyAsHumanUseCase } from "../../src/core/modules/conversations/application/use-cases/reply-as-human.use-case";
import { CaseRepositoryFake } from "../cases/fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../support/agent-audit.fakes";
import { ConversationRepositoryFake, DepartmentRepositoryFake, MessageRepositoryFake, WhatsAppSenderFake } from "../support/fakes";
import { silentLogger } from "../support/silent-logger";

function build() {
  const conversationRepo = new ConversationRepositoryFake();
  const messageRepo = new MessageRepositoryFake();
  const whatsappSender = new WhatsAppSenderFake();
  const auditRepo = new AuditRepositoryFake();
  const caseRepo = new CaseRepositoryFake();
  const agentRepo = new AgentRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const useCase = new ReplyAsHumanUseCase({
    conversationRepo,
    messageRepo,
    whatsappSender,
    auditRepo,
    logger: silentLogger,
    caseRepo,
    agentRepo,
    departmentRepo,
  });
  return { conversationRepo, caseRepo, agentRepo, departmentRepo, useCase };
}

describe("ReplyAsHumanUseCase — solo lectura para agentes no asignados (docs/spec/06_BACKEND_GAPS.md §2)", () => {
  it("permite responder si la conversacion no tiene un caso HUMAN_ACTIVE/ESCALATED (bot activo, sin dueno)", async () => {
    const { conversationRepo, agentRepo, useCase } = build();
    const conversation = conversationRepo.createOpen();
    const agent = agentRepo.seed({ name: "Cualquiera", email: "a@isp.local", role: "agent" });

    const message = await useCase.execute({ conversationId: conversation.id, agentUserId: agent.id, body: "hola" });
    expect(message.author).toBe("agent");
  });

  it("permite responder al agente asignado del caso HUMAN_ACTIVE", async () => {
    const { conversationRepo, caseRepo, agentRepo, departmentRepo, useCase } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const conversation = conversationRepo.createOpen();
    const owner = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent", primaryDepartmentId: support.id });
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
      status: "HUMAN_ACTIVE",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.setAssignedAgent(created.id, owner.id);

    const message = await useCase.execute({ conversationId: conversation.id, agentUserId: owner.id, body: "hola" });
    expect(message.author).toBe("agent");
  });

  it("bloquea a otro agente (no asignado, no manager) — solo lectura", async () => {
    const { conversationRepo, caseRepo, agentRepo, departmentRepo, useCase } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const conversation = conversationRepo.createOpen();
    const owner = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent", primaryDepartmentId: support.id });
    const other = agentRepo.seed({ name: "Beto", email: "beto@isp.local", role: "agent", primaryDepartmentId: support.id });
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
      status: "HUMAN_ACTIVE",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.setAssignedAgent(created.id, owner.id);

    await expect(
      useCase.execute({ conversationId: conversation.id, agentUserId: other.id, body: "hola" }),
    ).rejects.toMatchObject({ type: "AUTHORIZATION_ERROR" });
  });

  it("un manager del mismo departamento si puede responder por el agente asignado", async () => {
    const { conversationRepo, caseRepo, agentRepo, departmentRepo, useCase } = build();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const conversation = conversationRepo.createOpen();
    const owner = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent", primaryDepartmentId: support.id });
    const manager = agentRepo.seed({ name: "Jefa", email: "jefa@isp.local", role: "manager", primaryDepartmentId: support.id });
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
      status: "HUMAN_ACTIVE",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.setAssignedAgent(created.id, owner.id);

    const message = await useCase.execute({ conversationId: conversation.id, agentUserId: manager.id, body: "hola" });
    expect(message.author).toBe("agent");
  });
});
