import { describe, expect, it } from "vitest";
import { EscalatedQueueOverflowService } from "../../../src/core/modules/escalation/application/services/escalated-queue-overflow.service";
import { AutoAssignAgentService } from "../../../src/core/modules/escalation/application/services/auto-assign-agent.service";
import { EscalationRepositoryFake } from "../../../src/core/modules/escalation/infrastructure/postgres/escalation.repository.pg";
import { CaseRepositoryFake } from "../../cases/fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import {
  ConversationRepositoryFake,
  DepartmentRepositoryFake,
  MessageRepositoryFake,
} from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

function createHarness(options?: { maxConcurrent?: number }) {
  const agentRepo = new AgentRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const caseRepo = new CaseRepositoryFake();
  const escalationRepo = new EscalationRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const messageRepo = new MessageRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const connected = new Set<string>();
  const published: Array<{ type: string; caseId?: string; agentUserId?: string }> = [];

  const broadcaster = {
    isUserConnected: (userId: string) => connected.has(userId),
    publish: (event: { type: string; caseId?: string; agentUserId?: string }) => {
      published.push(event);
    },
  };

  const autoAssign = new AutoAssignAgentService({
    agentRepo,
    caseRepo,
    departmentRepo,
    broadcaster,
    maxActiveCasesPerAgent: options?.maxConcurrent ?? 2,
  });

  const overflowService = new EscalatedQueueOverflowService({
    escalationRepo,
    caseRepo,
    conversationRepo,
    departmentRepo,
    agentRepo,
    autoAssign,
    messageRepo,
    auditRepo,
    broadcaster,
    logger: silentLogger,
    defaultMaxConcurrentCases: options?.maxConcurrent ?? 2,
  });

  return {
    agentRepo,
    departmentRepo,
    caseRepo,
    escalationRepo,
    conversationRepo,
    messageRepo,
    auditRepo,
    connected,
    published,
    overflowService,
  };
}

async function seedEscalatedCase(
  h: ReturnType<typeof createHarness>,
  departmentId: string,
  createdAt: Date,
) {
  const conv = h.conversationRepo.createOpen();
  const agg = await h.caseRepo.create({
    conversationId: conv.id,
    workflowType: "GENERAL_INQUIRY",
    departmentId,
    context: { kind: "GENERAL_INQUIRY", topic: "consulta" },
    initialState: "ESCALATED",
    expiresAt: null,
  });
  await h.caseRepo.applyTransition({
    caseId: agg.case.id,
    expectedCaseVersion: agg.case.version,
    expectedWorkflowVersion: agg.workflowInstance.version,
    status: "ESCALATED",
    context: agg.case.context,
    currentState: agg.workflowInstance.currentState,
    departmentId,
    expiresAt: null,
  });
  const esc = await h.escalationRepo.create({
    caseId: agg.case.id,
    departmentId,
    reason: "REQUEST_HUMAN",
    priority: "normal",
    summary: {
      customerName: "Cliente",
      waPhone: conv.waPhone,
      intent: "general.inquiry",
      reason: "REQUEST_HUMAN",
      collectedEntities: {},
      attempts: 0,
      lastMessages: [],
    },
  });
  // Ajustar antigüedad simulada en el Map interno
  const stored = h.escalationRepo.items.get(esc.id);
  if (stored) {
    h.escalationRepo.items.set(esc.id, { ...stored, createdAt });
  }
  return { conv, caseId: agg.case.id, escalationId: esc.id };
}

describe("EscalatedQueueOverflowService", () => {
  const now = new Date("2026-11-23T18:00:00.000Z");

  it("desborda hacia fallbackDepartmentId y asigna a asesor en turno cuando el área origen tiene 0 conectados >= 15 min", async () => {
    const h = createHarness();
    const billingDept = h.departmentRepo.seed({
      slug: "cartera",
      name: "Facturación",
      maxConcurrentCases: 4,
    });
    const generalDept = h.departmentRepo.seed({
      slug: "general",
      name: "General",
      fallbackDepartmentId: billingDept.id,
    });

    const billingAgent = h.agentRepo.seed({
      name: "María Facturación",
      email: "maria@isp.local",
      role: "agent",
      primaryDepartmentId: billingDept.id,
      autoAssignEnabled: true,
    });
    h.connected.add(billingAgent.id);

    const seeded = await seedEscalatedCase(
      h,
      generalDept.id,
      new Date(now.getTime() - 25 * 60_000),
    );

    const count = await h.overflowService.overflowStaleQueues(now);
    expect(count).toBe(1);

    const updatedCase = await h.caseRepo.findById(seeded.caseId);
    expect(updatedCase?.case.status).toBe("HUMAN_ACTIVE");
    expect(updatedCase?.case.departmentId).toBe(billingDept.id);
    expect(updatedCase?.case.assignedAgentId).toBe(billingAgent.id);

    const updatedEsc = await h.escalationRepo.findById(seeded.escalationId);
    expect(updatedEsc?.status).toBe("ASSIGNED");
    expect(updatedEsc?.departmentId).toBe(billingDept.id);
    expect(updatedEsc?.assignedAgentId).toBe(billingAgent.id);

    const sysMsgs = h.messageRepo.messages.filter((m) => m.author === "system");
    expect(sysMsgs).toHaveLength(1);
    expect(sysMsgs[0]?.body).toContain("Desbordado automáticamente a María Facturación");
  });

  it("mueve la cola a fallbackDepartmentId si sus asesores están conectados pero temporalmente copados", async () => {
    const h = createHarness({ maxConcurrent: 1 });
    const supportDept = h.departmentRepo.seed({
      slug: "support",
      name: "Soporte",
      maxConcurrentCases: 1,
    });
    const trasladosDept = h.departmentRepo.seed({
      slug: "traslados",
      name: "Traslados",
      fallbackDepartmentId: supportDept.id,
    });

    const supportAgent = h.agentRepo.seed({
      name: "Ariel Soporte",
      email: "ariel@isp.local",
      role: "agent",
      primaryDepartmentId: supportDept.id,
      autoAssignEnabled: true,
    });
    h.connected.add(supportAgent.id);

    // Llenar el cupo (1) del agente de soporte con otro caso activo
    const busyConv = h.conversationRepo.createOpen();
    const busyAgg = await h.caseRepo.create({
      conversationId: busyConv.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: supportDept.id,
      context: { kind: "SUPPORT_INTERNET", retryCount: 0, attempts: 0 },
      initialState: "HUMAN_ACTIVE",
      expiresAt: null,
    });
    await h.caseRepo.applyTransition({
      caseId: busyAgg.case.id,
      expectedCaseVersion: busyAgg.case.version,
      expectedWorkflowVersion: busyAgg.workflowInstance.version,
      status: "HUMAN_ACTIVE",
      context: busyAgg.case.context,
      currentState: "HUMAN_ACTIVE",
      departmentId: supportDept.id,
      expiresAt: null,
    });
    await h.caseRepo.setAssignedAgent(busyAgg.case.id, supportAgent.id);

    const stranded = await seedEscalatedCase(
      h,
      trasladosDept.id,
      new Date(now.getTime() - 20 * 60_000),
    );

    const count = await h.overflowService.overflowStaleQueues(now);
    expect(count).toBe(1);

    const updatedCase = await h.caseRepo.findById(stranded.caseId);
    expect(updatedCase?.case.status).toBe("ESCALATED");
    expect(updatedCase?.case.departmentId).toBe(supportDept.id);
    expect(updatedCase?.case.assignedAgentId).toBeNull();

    const updatedEsc = await h.escalationRepo.findById(stranded.escalationId);
    expect(updatedEsc?.status).toBe("PENDING");
    expect(updatedEsc?.departmentId).toBe(supportDept.id);
  });

  it("asigna a supervisión (manager conectado) cuando el departamento no tiene respaldo ni asesores en turno", async () => {
    const h = createHarness();
    const generalDept = h.departmentRepo.seed({
      slug: "general",
      name: "General",
    });

    const supervisor = h.agentRepo.seed({
      name: "Supervisor Turno",
      email: "sup@isp.local",
      role: "manager",
      primaryDepartmentId: null,
      autoAssignEnabled: true,
    });
    h.connected.add(supervisor.id);

    const seeded = await seedEscalatedCase(
      h,
      generalDept.id,
      new Date(now.getTime() - 30 * 60_000),
    );

    const count = await h.overflowService.overflowStaleQueues(now);
    expect(count).toBe(1);

    const updatedCase = await h.caseRepo.findById(seeded.caseId);
    expect(updatedCase?.case.status).toBe("HUMAN_ACTIVE");
    expect(updatedCase?.case.assignedAgentId).toBe(supervisor.id);
    expect(h.messageRepo.messages[0]?.body).toContain("Asignado automáticamente a supervisión");
  });

  it("NO desborda si el departamento origen SÍ tiene asesores conectados (aunque copados) ni antes de los 15 min", async () => {
    const h = createHarness({ maxConcurrent: 1 });
    const billingDept = h.departmentRepo.seed({ slug: "cartera", name: "Facturación", maxConcurrentCases: 1 });
    const generalDept = h.departmentRepo.seed({
      slug: "general",
      name: "General",
      fallbackDepartmentId: billingDept.id,
    });

    const billingAgent = h.agentRepo.seed({
      name: "Ana Facturación",
      email: "ana@isp.local",
      role: "agent",
      primaryDepartmentId: billingDept.id,
      autoAssignEnabled: true,
    });
    const generalAgent = h.agentRepo.seed({
      name: "Luis General",
      email: "luis@isp.local",
      role: "agent",
      primaryDepartmentId: generalDept.id,
      autoAssignEnabled: true,
    });
    h.connected.add(billingAgent.id);
    h.connected.add(generalAgent.id);

    // Ocupar al agente de General para que esté copado
    const c1 = await seedEscalatedCase(h, generalDept.id, new Date(now.getTime() - 30 * 60_000));
    const freshInEmptyDept = h.departmentRepo.seed({ slug: "soporte", name: "Soporte" });
    await seedEscalatedCase(h, freshInEmptyDept.id, new Date(now.getTime() - 5 * 60_000));

    // General SÍ tiene a Luis conectado -> no desborda. Soporte tiene < 15 min -> no desborda.
    const count = await h.overflowService.overflowStaleQueues(now);
    expect(count).toBe(0);

    const unchanged = await h.caseRepo.findById(c1.caseId);
    expect(unchanged?.case.departmentId).toBe(generalDept.id);
    expect(unchanged?.case.status).toBe("ESCALATED");
  });
});
