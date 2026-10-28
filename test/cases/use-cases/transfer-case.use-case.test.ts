import { describe, expect, it } from "vitest";
import { TransferCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/transfer-case.use-case";
import { AutoAssignAgentService } from "../../../src/core/modules/escalation/application/services/auto-assign-agent.service";
import { RealtimeBroadcaster, type RealtimeEvent } from "../../../src/core/modules/realtime/application/realtime-broadcaster";
import { EscalationRepositoryFake } from "../../../src/core/modules/escalation/infrastructure/postgres/escalation.repository.pg";
import { CaseRepositoryFake } from "../fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import { DepartmentRepositoryFake, MessageRepositoryFake } from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

function buildTestStack() {
  const caseRepo = new CaseRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const agentRepo = new AgentRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const escalationRepo = new EscalationRepositoryFake();
  const messageRepo = new MessageRepositoryFake();
  const broadcaster = new RealtimeBroadcaster();

  const autoAssign = new AutoAssignAgentService({
    agentRepo,
    caseRepo,
  });

  const transferCase = new TransferCaseUseCase({
    caseRepo,
    departmentRepo,
    auditRepo,
    logger: silentLogger,
    autoAssign,
    escalationRepo,
    broadcaster,
    messageRepo,
    agentRepo,
  });

  const support = departmentRepo.seed({
    name: "Soporte Técnico",
    slug: "support",
    visibility: "shared",
    active: true,
  });

  const billing = departmentRepo.seed({
    name: "Facturación",
    slug: "billing",
    visibility: "shared",
    active: true,
  });

  return {
    caseRepo,
    departmentRepo,
    agentRepo,
    auditRepo,
    escalationRepo,
    messageRepo,
    broadcaster,
    autoAssign,
    transferCase,
    support,
    billing,
  };
}

describe("TransferCaseUseCase - Auto-asignación al transferir de área", () => {
  it("asigna automáticamente al agente disponible del nuevo departamento y pasa a HUMAN_ACTIVE", async () => {
    const { caseRepo, agentRepo, transferCase, support, billing, broadcaster } = buildTestStack();

    // Agente inicial en soporte
    const agentSupport = agentRepo.seed({
      name: "Jessica Chicaiza",
      email: "jessica@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      active: true,
      autoAssignEnabled: true,
    });

    // Agentes en Facturación: uno ocupado y uno libre
    const busyBilling = agentRepo.seed({
      name: "Agente Ocupado",
      email: "busy@isp.local",
      role: "agent",
      primaryDepartmentId: billing.id,
      active: true,
      autoAssignEnabled: true,
    });

    const freeBilling = agentRepo.seed({
      name: "Agente de Cartera",
      email: "cartera@isp.local",
      role: "agent",
      primaryDepartmentId: billing.id,
      active: true,
      autoAssignEnabled: true,
    });

    // Simular que busyBilling ya tiene 2 casos activos
    for (let i = 0; i < 2; i++) {
      const { case: c } = await caseRepo.create({
        conversationId: `conv-busy-${i}`,
        workflowType: "SUPPORT_INTERNET",
        departmentId: billing.id,
        context: { workflowType: "SUPPORT_INTERNET", data: {} },
        initialState: "VALIDATE_CLIENT",
        expiresAt: null,
      });
      await caseRepo.applyTransition({
        caseId: c.id,
        expectedCaseVersion: c.version,
        expectedWorkflowVersion: 1,
        status: "HUMAN_ACTIVE",
        context: c.context,
        currentState: "VALIDATE_CLIENT",
        expiresAt: null,
      });
      await caseRepo.setAssignedAgent(c.id, busyBilling.id);
    }

    // Crear el caso actual atendido por Jessica en soporte
    const { case: currentCase } = await caseRepo.create({
      conversationId: "conv-client-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: currentCase.id,
      expectedCaseVersion: currentCase.version,
      expectedWorkflowVersion: 1,
      status: "HUMAN_ACTIVE",
      context: currentCase.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.setAssignedAgent(currentCase.id, agentSupport.id);

    const eventsReceived: RealtimeEvent[] = [];
    broadcaster.subscribe({
      userId: agentSupport.id,
      departmentIds: new Set([support.id, billing.id]),
      role: "agent",
      send: (e) => eventsReceived.push(e),
    });

    // Transferir a Facturación
    const transferred = await transferCase.execute({
      caseId: currentCase.id,
      toDepartmentId: billing.id,
      reason: "Cliente consulta sobre su factura pendiente",
      agentUserId: agentSupport.id,
    });

    // Debe pertenecer a Facturación
    expect(transferred.departmentId).toBe(billing.id);
    // Debe haber sido asignado automáticamente al agente de Facturación con menor carga
    expect(transferred.assignedAgentId).toBe(freeBilling.id);
    expect(transferred.status).toBe("HUMAN_ACTIVE");

    // Verificar en repositorio
    const persisted = await caseRepo.findById(currentCase.id);
    expect(persisted?.case.departmentId).toBe(billing.id);
    expect(persisted?.case.assignedAgentId).toBe(freeBilling.id);

    // Debe emitir evento realtime HUMAN_ASSIGNED
    const assignEvent = eventsReceived.find((e) => e.type === "HUMAN_ASSIGNED");
    expect(assignEvent).toBeDefined();
    if (assignEvent && assignEvent.type === "HUMAN_ASSIGNED") {
      expect(assignEvent.caseId).toBe(currentCase.id);
      expect(assignEvent.agentUserId).toBe(freeBilling.id);
    }
  });

  it("actualiza la escalación asociada con el nuevo departamento y agente asignado", async () => {
    const { caseRepo, agentRepo, escalationRepo, transferCase, support, billing } = buildTestStack();

    const billingAgent = agentRepo.seed({
      name: "Agente Facturación",
      email: "billing@isp.local",
      role: "agent",
      primaryDepartmentId: billing.id,
      active: true,
      autoAssignEnabled: true,
    });

    const { case: currentCase } = await caseRepo.create({
      conversationId: "conv-esc-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    // Crear escalación previa
    await escalationRepo.create({
      caseId: currentCase.id,
      departmentId: support.id,
      priority: "normal",
      reason: "REQUEST_HUMAN",
      summary: {
        problem: "Consulta",
        workflow: "SUPPORT_INTERNET",
        department: "support",
        status: "ESCALATED",
        reason: "REQUEST_HUMAN",
        completedSteps: [],
        results: {},
        pendingAction: "none",
        timeline: [],
        readableSummary: "Requiere atención",
      },
    });

    await transferCase.execute({
      caseId: currentCase.id,
      toDepartmentId: billing.id,
      reason: "Transferencia a facturación",
      agentUserId: "user-admin",
    });

    const escalation = await escalationRepo.findByCaseId(currentCase.id);
    expect(escalation?.departmentId).toBe(billing.id);
    expect(escalation?.assignedAgentId).toBe(billingAgent.id);
    expect(escalation?.status).toBe("ASSIGNED");
  });

  it("asigna al agente activo mediante fallbackToAnyActive si nadie tiene autoAssignEnabled activo", async () => {
    const { caseRepo, agentRepo, transferCase, support, billing } = buildTestStack();

    // Agente activo en facturación pero con autoAssignEnabled: false
    const fallbackAgent = agentRepo.seed({
      name: "Sara Terán",
      email: "sara@isp.local",
      role: "agent",
      primaryDepartmentId: billing.id,
      active: true,
      autoAssignEnabled: false,
    });

    const { case: currentCase } = await caseRepo.create({
      conversationId: "conv-fallback-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const transferred = await transferCase.execute({
      caseId: currentCase.id,
      toDepartmentId: billing.id,
      reason: "Transferencia con fallback",
      agentUserId: "user-admin",
    });

    expect(transferred.assignedAgentId).toBe(fallbackAgent.id);
  });

  it("queda sin asignar (null) de forma segura si el nuevo departamento no tiene ningún agente activo", async () => {
    const { caseRepo, transferCase, support, billing } = buildTestStack();

    // No creamos ningún agente en facturación
    const { case: currentCase } = await caseRepo.create({
      conversationId: "conv-empty-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const transferred = await transferCase.execute({
      caseId: currentCase.id,
      toDepartmentId: billing.id,
      reason: "Depto vacío",
      agentUserId: "user-admin",
    });

    expect(transferred.departmentId).toBe(billing.id);
    expect(transferred.assignedAgentId).toBeNull();
  });

  it("inserta un mensaje del sistema en la conversación como respaldo de la transferencia", async () => {
    const { caseRepo, agentRepo, messageRepo, transferCase, support, billing } = buildTestStack();

    const actor = agentRepo.seed({
      name: "Jessica Chicaiza",
      email: "jessica2@isp.local",
      role: "agent",
      primaryDepartmentId: support.id,
      active: true,
    });

    const target = agentRepo.seed({
      name: "Carlos Pérez",
      email: "carlos@isp.local",
      role: "agent",
      primaryDepartmentId: billing.id,
      active: true,
    });

    const { case: currentCase } = await caseRepo.create({
      conversationId: "conv-trace-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    await transferCase.execute({
      caseId: currentCase.id,
      toDepartmentId: billing.id,
      toAgentId: target.id,
      reason: "Verificación de pago",
      agentUserId: actor.id,
    });

    const messages = await messageRepo.listByConversation("conv-trace-1");
    const systemMsg = messages.find((m) => m.author === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.body).toContain("Facturación");
    expect(systemMsg?.body).toContain("Carlos Pérez");
    expect(systemMsg?.body).toContain("Jessica Chicaiza");
    expect(systemMsg?.body).toContain("Verificación de pago");
  });

  it("permite transferir directamente a un agente específico (toAgentId)", async () => {
    const { caseRepo, agentRepo, transferCase, support, billing } = buildTestStack();

    const specificAgent = agentRepo.seed({
      name: "Agente Específico",
      email: "especifico@isp.local",
      role: "agent",
      primaryDepartmentId: billing.id,
      active: true,
      autoAssignEnabled: false,
    });

    const { case: currentCase } = await caseRepo.create({
      conversationId: "conv-specific-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: support.id,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const transferred = await transferCase.execute({
      caseId: currentCase.id,
      toAgentId: specificAgent.id,
      reason: "Transferencia directa a especialista",
      agentUserId: "user-admin",
    });

    expect(transferred.assignedAgentId).toBe(specificAgent.id);
    expect(transferred.departmentId).toBe(billing.id);
  });
});

