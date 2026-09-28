import { describe, expect, it } from "vitest";
import { CompleteCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/complete-case.use-case";
import { ScheduleCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/schedule-case.use-case";
import { ScheduledReminderNotifierService } from "../../../src/core/modules/cases/application/services/scheduled-reminder-notifier.service";
import { RealtimeBroadcaster } from "../../../src/core/modules/realtime/application/realtime-broadcaster";
import { CaseRepositoryFake } from "../fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import { ConversationRepositoryFake, DepartmentRepositoryFake } from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

function buildSetup() {
  const caseRepo = new CaseRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const agentRepo = new AgentRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const broadcaster = new RealtimeBroadcaster();

  const completeCase = new CompleteCaseUseCase({
    caseRepo,
    conversationRepo,
    auditRepo,
    logger: silentLogger,
    agentRepo,
    departmentRepo,
    broadcaster,
  });

  const scheduleCase = new ScheduleCaseUseCase({
    caseRepo,
    auditRepo,
    logger: silentLogger,
    broadcaster,
  });

  const notifierService = new ScheduledReminderNotifierService({
    caseRepo,
    broadcaster,
    logger: silentLogger,
  });

  return { caseRepo, conversationRepo, auditRepo, agentRepo, departmentRepo, broadcaster, completeCase, scheduleCase, notifierService };
}

describe("Cierre manual y agendamiento de casos", () => {
  it("completa un caso con motivo CLIENT_NO_RESPONSE (falta de respuesta)", async () => {
    const { caseRepo, agentRepo, departmentRepo, completeCase } = buildSetup();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent", primaryDepartmentId: support.id });

    const { case: created } = await caseRepo.create({
      conversationId: "conv-1",
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
    await caseRepo.setAssignedAgent(created.id, agent.id);

    const result = await completeCase.execute({
      caseId: created.id,
      agentUserId: agent.id,
      closeReason: "CLIENT_NO_RESPONSE",
      resolutionNote: "El cliente dejó de responder",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.context.closeReason).toBe("CLIENT_NO_RESPONSE");

    const events = await caseRepo.listEvents(created.id);
    const completedEvent = events.find((e) => e.type === "CASE_COMPLETED");
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.payload).toMatchObject({
      closeReason: "CLIENT_NO_RESPONSE",
      resolutionNote: "El cliente dejó de responder",
    });
  });

  it("completa un caso con motivo RESOLVED (cierre normal por defecto)", async () => {
    const { caseRepo, agentRepo, departmentRepo, completeCase } = buildSetup();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const agent = agentRepo.seed({ name: "Ana", email: "ana@isp.local", role: "agent", primaryDepartmentId: support.id });

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
      status: "HUMAN_ACTIVE",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.setAssignedAgent(created.id, agent.id);

    const result = await completeCase.execute({
      caseId: created.id,
      agentUserId: agent.id,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.context.closeReason).toBe("RESOLVED");
  });

  it("agenda un caso a la sección En Espera y emite alerta interna SSE al cumplirse la hora", async () => {
    const { caseRepo, agentRepo, departmentRepo, scheduleCase, notifierService, broadcaster } = buildSetup();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const agent = agentRepo.seed({ name: "Carlos", email: "carlos@isp.local", role: "agent", primaryDepartmentId: support.id });

    const { case: created } = await caseRepo.create({
      conversationId: "conv-3",
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
    await caseRepo.setAssignedAgent(created.id, agent.id);

    // Agendar para 100ms en el futuro con etiqueta MONITOREO
    const scheduledTime = new Date(Date.now() + 50);
    const scheduledCase = await scheduleCase.execute({
      caseId: created.id,
      agentUserId: agent.id,
      scheduledAt: scheduledTime,
      scheduleTag: "MONITOREO",
      reminderReason: "Verificar servicio con el cliente",
    });

    expect(scheduledCase.status).toBe("WAITING_USER");
    expect(scheduledCase.context.schedulingMetadata).toMatchObject({
      scheduleTag: "MONITOREO",
      reminderReason: "Verificar servicio con el cliente",
      scheduledByAgentId: agent.id,
      notifiedAt: null,
    });

    // Escuchar evento SSE
    let receivedEvent: any = null;
    broadcaster.subscribe({
      userId: agent.id,
      role: "agent",
      departmentIds: new Set([support.id]),
      send: (evt) => {
        if (evt.type === "CASE_SCHEDULED_REMINDER") {
          receivedEvent = evt;
        }
      },
    });

    // Esperar a que la fecha transcurra
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Ejecutar chequeo de recordatorios
    const notifiedCount = await notifierService.checkScheduledReminders();
    expect(notifiedCount).toBe(1);

    expect(receivedEvent).toMatchObject({
      type: "CASE_SCHEDULED_REMINDER",
      caseId: created.id,
      conversationId: "conv-3",
      scheduleTag: "MONITOREO",
      reminderReason: "Verificar servicio con el cliente",
    });
  });

  it("permite agendar con una etiqueta personalizada dinámica", async () => {
    const { caseRepo, agentRepo, departmentRepo, scheduleCase } = buildSetup();
    const support = departmentRepo.seed({ slug: "support", name: "Soporte" });
    const agent = agentRepo.seed({ name: "Carlos", email: "carlos@isp.local", role: "agent", primaryDepartmentId: support.id });

    const { case: created } = await caseRepo.create({
      conversationId: "conv-4",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const scheduledCase = await scheduleCase.execute({
      caseId: created.id,
      agentUserId: agent.id,
      scheduledAt: new Date(Date.now() + 60000),
      scheduleTag: "revision_tecnica",
    });

    expect(scheduledCase.context.schedulingMetadata?.scheduleTag).toBe("REVISION_TECNICA");
  });
});
