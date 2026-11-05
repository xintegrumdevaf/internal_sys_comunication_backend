import { describe, expect, it } from "vitest";
import { DrainDepartmentQueueService } from "../../../src/core/modules/escalation/application/services/drain-department-queue.service";
import { AutoAssignAgentService } from "../../../src/core/modules/escalation/application/services/auto-assign-agent.service";
import { CaseRepositoryFake } from "../../cases/fakes";
import { AgentRepositoryFake, AuditRepositoryFake } from "../../support/agent-audit.fakes";
import { DepartmentRepositoryFake, ConversationRepositoryFake } from "../../support/fakes";
import { EscalationRepositoryFake } from "../../../src/core/modules/escalation/infrastructure/postgres/escalation.repository.pg";
import { silentLogger } from "../../support/silent-logger";

function buildTestHarness(options?: {
  defaultMaxConcurrent?: number;
  connectedUserIds?: Set<string>;
}) {
  const agentRepo = new AgentRepositoryFake();
  const departmentRepo = new DepartmentRepositoryFake();
  const caseRepo = new CaseRepositoryFake();
  const escalationRepo = new EscalationRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const auditRepo = new AuditRepositoryFake();
  const connected = options?.connectedUserIds ?? new Set<string>();

  const broadcaster = {
    isUserConnected: (userId: string) => connected.has(userId),
    publish: () => {},
  };

  const autoAssign = new AutoAssignAgentService({
    agentRepo,
    caseRepo,
    departmentRepo,
    broadcaster,
    maxActiveCasesPerAgent: options?.defaultMaxConcurrent ?? 6,
  });

  const drainService = new DrainDepartmentQueueService({
    agentRepo,
    departmentRepo,
    caseRepo,
    escalationRepo,
    conversationRepo,
    auditRepo,
    broadcaster,
    logger: silentLogger,
    defaultMaxConcurrentCases: options?.defaultMaxConcurrent ?? 6,
  });

  return {
    agentRepo,
    departmentRepo,
    caseRepo,
    escalationRepo,
    conversationRepo,
    auditRepo,
    connected,
    autoAssign,
    drainService,
  };
}

async function seedEscalatedCase(
  caseRepo: CaseRepositoryFake,
  escalationRepo: EscalationRepositoryFake,
  departmentId: string,
  priority: "low" | "normal" | "high" | "urgent" = "normal",
) {
  const { case: created } = await caseRepo.create({
    conversationId: `conv-${Math.random()}`,
    workflowType: "SUPPORT_INTERNET",
    departmentId,
    context: { workflowType: "SUPPORT_INTERNET", data: {} },
    initialState: "VALIDATE_CLIENT",
    expiresAt: null,
  });

  await caseRepo.applyTransition({
    caseId: created.id,
    expectedCaseVersion: created.version,
    expectedWorkflowVersion: 1,
    status: "ESCALATED",
    context: created.context,
    currentState: "VALIDATE_CLIENT",
    expiresAt: null,
  });

  const escalation = await escalationRepo.create({
    caseId: created.id,
    departmentId,
    priority,
    reason: "TEST_ESCALATION",
    summary: {
      problem: "Test",
      workflow: "SUPPORT_INTERNET",
      department: departmentId,
      status: "PENDING",
      reason: "TEST_ESCALATION",
      completedSteps: [],
      results: {},
      pendingAction: "NONE",
      timeline: [],
    },
  });

  return { caseEntity: created, escalation };
}

async function seedHumanActiveCase(caseRepo: CaseRepositoryFake, agentId: string, departmentId: string) {
  const { case: created } = await caseRepo.create({
    conversationId: `conv-${Math.random()}`,
    workflowType: "SUPPORT_INTERNET",
    departmentId,
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

  await caseRepo.setAssignedAgent(created.id, agentId);
  return created;
}

describe("DrainDepartmentQueueService & Concurrency Cap (Paced FIFO Dispatch)", () => {
  it("no asigna casos si un agente ya alcanzó su cupo máximo de concurrencia en AutoAssignAgentService", async () => {
    const { departmentRepo, agentRepo, caseRepo, connected, autoAssign } = buildTestHarness();

    const dept = departmentRepo.seed({
      slug: "support",
      name: "Soporte",
      maxConcurrentCases: 2,
    });

    const agent = agentRepo.seed({
      name: "Carlos",
      email: "carlos@isp.local",
      role: "agent",
      primaryDepartmentId: dept.id,
      autoAssignEnabled: true,
    });
    connected.add(agent.id);

    // Con 1 caso activo, aún tiene 1 cupo disponible
    await seedHumanActiveCase(caseRepo, agent.id, dept.id);
    const firstPick = await autoAssign.pickAgentForDepartment(dept.id);
    expect(firstPick?.id).toBe(agent.id);

    // Con 2 casos activos, su cupo (maxConcurrentCases: 2) está lleno
    await seedHumanActiveCase(caseRepo, agent.id, dept.id);
    const secondPick = await autoAssign.pickAgentForDepartment(dept.id);
    expect(secondPick).toBeNull();
  });

  it("no drena casos si no hay ningún asesor conectado con auto-assign activo", async () => {
    const { departmentRepo, agentRepo, caseRepo, escalationRepo, drainService } = buildTestHarness();

    const dept = departmentRepo.seed({ slug: "support", name: "Soporte", maxConcurrentCases: 6 });
    agentRepo.seed({
      name: "Offline",
      email: "offline@isp.local",
      role: "agent",
      primaryDepartmentId: dept.id,
      autoAssignEnabled: true,
    });
    // Agente no está en 'connected'

    await seedEscalatedCase(caseRepo, escalationRepo, dept.id);
    const drained = await drainService.drainQueueForDepartment(dept.id);

    expect(drained).toBe(0);
    const pending = await escalationRepo.list({ status: "PENDING", departmentId: dept.id });
    expect(pending).toHaveLength(1);
  });

  it("drena progresivamente hasta el cupo del departamento sin saturar al asesor", async () => {
    const { departmentRepo, agentRepo, caseRepo, escalationRepo, connected, drainService } = buildTestHarness();

    // Depto con límite de 3 casos simultáneos
    const dept = departmentRepo.seed({ slug: "support", name: "Soporte", maxConcurrentCases: 3 });

    const agent = agentRepo.seed({
      name: "Erick",
      email: "erick@isp.local",
      role: "agent",
      primaryDepartmentId: dept.id,
      autoAssignEnabled: true,
    });
    connected.add(agent.id);

    // Erick ya tiene 1 caso en atención humana (le quedan 2 cupos libres)
    await seedHumanActiveCase(caseRepo, agent.id, dept.id);

    // En la cola hay 5 casos esperando
    for (let i = 0; i < 5; i++) {
      await seedEscalatedCase(caseRepo, escalationRepo, dept.id);
    }

    // Al drenar, debe tomar exactamente 2 casos (completando sus 3 cupos) y dejar 3 en cola
    const drained = await drainService.drainQueueForDepartment(dept.id);
    expect(drained).toBe(2);

    const activeCounts = await caseRepo.countActiveCasesByAgent([agent.id]);
    expect(activeCounts[agent.id]).toBe(3); // 1 previo + 2 drenados = 3 (tope alcanzado)

    const pending = await escalationRepo.list({ status: "PENDING", departmentId: dept.id });
    expect(pending).toHaveLength(3); // 5 - 2 = 3 pendientes en cola
  });

  it("distribuye equitativamente (Least-Connections) entre múltiples asesores conectados", async () => {
    const { departmentRepo, agentRepo, caseRepo, escalationRepo, connected, drainService } = buildTestHarness();

    const dept = departmentRepo.seed({ slug: "billing", name: "Facturación", maxConcurrentCases: 4 });

    const ana = agentRepo.seed({
      name: "Ana",
      email: "ana@isp.local",
      role: "agent",
      primaryDepartmentId: dept.id,
      autoAssignEnabled: true,
    });
    const beto = agentRepo.seed({
      name: "Beto",
      email: "beto@isp.local",
      role: "agent",
      primaryDepartmentId: dept.id,
      autoAssignEnabled: true,
    });
    connected.add(ana.id);
    connected.add(beto.id);

    // Ana tiene 2 casos, Beto tiene 1 caso
    await seedHumanActiveCase(caseRepo, ana.id, dept.id);
    await seedHumanActiveCase(caseRepo, ana.id, dept.id);
    await seedHumanActiveCase(caseRepo, beto.id, dept.id);

    // Encolamos 3 casos nuevos
    for (let i = 0; i < 3; i++) {
      await seedEscalatedCase(caseRepo, escalationRepo, dept.id);
    }

    // Al drenar:
    // Caso 1: Beto tiene 1, Ana tiene 2 -> se lo asigna a Beto (Beto pasa a 2).
    // Caso 2: Ambos tienen 2 -> desempate alfabético ("Ana" vs "Beto" -> Ana pasa a 3).
    // Caso 3: Beto tiene 2, Ana tiene 3 -> se lo asigna a Beto (Beto pasa a 3).
    const drained = await drainService.drainQueueForDepartment(dept.id);
    expect(drained).toBe(3);

    const counts = await caseRepo.countActiveCasesByAgent([ana.id, beto.id]);
    expect(counts[ana.id]).toBe(3);
    expect(counts[beto.id]).toBe(3);
  });

  it("drena colas automáticamente al activar la disponibilidad del agente (drainQueueForAgent)", async () => {
    const { departmentRepo, agentRepo, caseRepo, escalationRepo, connected, drainService } = buildTestHarness();

    const dept = departmentRepo.seed({ slug: "sales", name: "Ventas", maxConcurrentCases: 2 });
    const agent = agentRepo.seed({
      name: "Vendedora",
      email: "ventas@isp.local",
      role: "agent",
      primaryDepartmentId: dept.id,
      autoAssignEnabled: true,
    });
    connected.add(agent.id);

    await seedEscalatedCase(caseRepo, escalationRepo, dept.id);
    await seedEscalatedCase(caseRepo, escalationRepo, dept.id);
    await seedEscalatedCase(caseRepo, escalationRepo, dept.id);

    const drained = await drainService.drainQueueForAgent(agent.id);
    expect(drained).toBe(2);

    const counts = await caseRepo.countActiveCasesByAgent([agent.id]);
    expect(counts[agent.id]).toBe(2);
  });
});
