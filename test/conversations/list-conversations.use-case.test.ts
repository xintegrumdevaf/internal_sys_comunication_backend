import { describe, it, expect } from "vitest";
import { ListConversationsUseCase } from "../../src/core/modules/conversations/application/use-cases/list-conversations.use-case";
import {
  ConversationRepositoryFake,
  MessageRepositoryFake,
  DepartmentRepositoryFake,
} from "../support/fakes";
import { CaseRepositoryFake } from "../cases/fakes";
import { emptyContextFor } from "../../src/core/modules/cases/domain/contexts/case-context";

describe("ListConversationsUseCase - filtrado por caso activo", () => {
  it("no incluye conversaciones cuyo caso activo sea de otro departamento aunque tengan historial previo", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const caseRepo = new CaseRepositoryFake();
    const departmentRepo = new DepartmentRepositoryFake();

    const deptCartera = departmentRepo.seed({ slug: "cartera", name: "Cartera" });
    const deptSoporte = departmentRepo.seed({ slug: "soporte", name: "Soporte" });

    // Conversación 1: Caso histórico en Cartera (cerrado/completado), pero caso ACTIVO en Soporte
    const conv1 = conversationRepo.createOpen({
      id: "conv-1",
      waPhone: "+593983888426",
      status: "open",
    });
    messageRepo.seedText(conv1.id, "No tengo internet");

    // Caso 1 (Histórico - Cartera)
    const { case: oldCarteraCase, workflowInstance: oldWf } = await caseRepo.create({
      conversationId: conv1.id,
      workflowType: "BILLING_BALANCE",
      departmentId: deptCartera.id,
      context: emptyContextFor("BILLING_BALANCE"),
      initialState: "START",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: oldCarteraCase.id,
      expectedCaseVersion: oldCarteraCase.version,
      expectedWorkflowVersion: oldWf.version,
      status: "COMPLETED",
      context: oldCarteraCase.context,
      currentState: "COMPLETED",
      expiresAt: null,
    });

    // Caso 2 (Activo - Soporte)
    const { case: activeSoporteCase } = await caseRepo.create({
      conversationId: conv1.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: deptSoporte.id,
      context: emptyContextFor("SUPPORT_INTERNET"),
      initialState: "START",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: activeSoporteCase.id,
      expectedCaseVersion: activeSoporteCase.version,
      expectedWorkflowVersion: 1,
      status: "HUMAN_ACTIVE",
      context: activeSoporteCase.context,
      currentState: "HUMAN_ACTIVE",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conv1.id, activeSoporteCase.id);

    // Conversación 2: Caso activo en Cartera
    const conv2 = conversationRepo.createOpen({
      id: "conv-2",
      waPhone: "+593984278832",
      status: "open",
    });
    messageRepo.seedText(conv2.id, "Quiero pagar mi factura");
    const { case: activeCarteraCase } = await caseRepo.create({
      conversationId: conv2.id,
      workflowType: "BILLING_BALANCE",
      departmentId: deptCartera.id,
      context: emptyContextFor("BILLING_BALANCE"),
      initialState: "START",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conv2.id, activeCarteraCase.id);

    const listUseCase = new ListConversationsUseCase(
      conversationRepo,
      messageRepo,
      caseRepo,
      undefined,
      departmentRepo,
    );

    // Al filtrar por Cartera, SOLO debe aparecer conv2; conv1 NO debe aparecer aunque tenga un caso viejo de Cartera
    const carteraList = await listUseCase.execute({ departmentId: deptCartera.id });
    expect(carteraList).toHaveLength(1);
    expect(carteraList[0]!.id).toBe(conv2.id);
    expect(carteraList[0]!.activeCase?.departmentId).toBe(deptCartera.id);
    expect(carteraList[0]!.activeCase?.departmentName).toBe("Cartera");

    // Al filtrar por Soporte, debe aparecer conv1 con su caso activo de Soporte
    const soporteList = await listUseCase.execute({ departmentId: deptSoporte.id });
    expect(soporteList).toHaveLength(1);
    expect(soporteList[0]!.id).toBe(conv1.id);
    expect(soporteList[0]!.activeCase?.departmentId).toBe(deptSoporte.id);
    expect(soporteList[0]!.activeCase?.departmentName).toBe("Soporte");
  });

  it("filtra por agente asignado (userId) considerando únicamente el caso activo", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const caseRepo = new CaseRepositoryFake();

    const conv = conversationRepo.createOpen({
      id: "conv-user-1",
      waPhone: "+593981111111",
      status: "open",
    });
    messageRepo.seedText(conv.id, "Mensaje de prueba");

    // Caso viejo asignado a "agent-old"
    const { case: oldCase, workflowInstance: oldWf } = await caseRepo.create({
      conversationId: conv.id,
      workflowType: "BILLING_BALANCE",
      departmentId: "dept-cartera",
      context: emptyContextFor("BILLING_BALANCE"),
      initialState: "START",
      expiresAt: null,
    });
    await caseRepo.setAssignedAgent(oldCase.id, "agent-old");
    await caseRepo.applyTransition({
      caseId: oldCase.id,
      expectedCaseVersion: oldCase.version,
      expectedWorkflowVersion: oldWf.version,
      status: "COMPLETED",
      context: oldCase.context,
      currentState: "COMPLETED",
      expiresAt: null,
    });

    // Caso activo asignado a "agent-active"
    const { case: activeCase } = await caseRepo.create({
      conversationId: conv.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: "dept-soporte",
      context: emptyContextFor("SUPPORT_INTERNET"),
      initialState: "START",
      expiresAt: null,
    });
    await caseRepo.setAssignedAgent(activeCase.id, "agent-active");
    await conversationRepo.setActiveCaseId(conv.id, activeCase.id);

    const listUseCase = new ListConversationsUseCase(conversationRepo, messageRepo, caseRepo);

    // Filtrar por agent-old no debe retornar la conversación porque no es su caso activo
    const oldAgentList = await listUseCase.execute({ userId: "agent-old" });
    expect(oldAgentList).toHaveLength(0);

    // Filtrar por agent-active sí debe retornarla
    const activeAgentList = await listUseCase.execute({ userId: "agent-active" });
    expect(activeAgentList).toHaveLength(1);
    expect(activeAgentList[0]!.id).toBe(conv.id);
    expect(activeAgentList[0]!.activeCase?.assignedAgentId).toBe("agent-active");
  });

  it("en una conversación resuelta conserva quién atendió el último caso, sin tratarlo como caso activo", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const caseRepo = new CaseRepositoryFake();

    const conv = conversationRepo.createOpen({
      id: "conv-resolved",
      waPhone: "+593982222222",
      status: "resolved",
    });
    messageRepo.seedText(conv.id, "Gracias");

    const { case: doneCase, workflowInstance } = await caseRepo.create({
      conversationId: conv.id,
      workflowType: "BILLING_BALANCE",
      departmentId: "dept-cartera",
      context: emptyContextFor("BILLING_BALANCE"),
      initialState: "START",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: doneCase.id,
      expectedCaseVersion: doneCase.version,
      expectedWorkflowVersion: workflowInstance.version,
      status: "COMPLETED",
      context: doneCase.context,
      currentState: "COMPLETED",
      expiresAt: null,
    });
    await caseRepo.setAssignedAgent(doneCase.id, "agent-erick");

    const listUseCase = new ListConversationsUseCase(conversationRepo, messageRepo, caseRepo);

    const byAgent = await listUseCase.execute({ userId: "agent-erick" });
    expect(byAgent).toHaveLength(1);
    expect(byAgent[0]!.activeCase).toBeNull();
    expect(byAgent[0]!.lastAttendedBy).toEqual({
      agentId: "agent-erick",
      agentName: null,
    });

    const otherAgent = await listUseCase.execute({ userId: "agent-other" });
    expect(otherAgent).toHaveLength(0);

    const byDept = await listUseCase.execute({ departmentId: "dept-cartera" });
    expect(byDept).toHaveLength(1);
    expect(byDept[0]!.id).toBe(conv.id);
  });

  it("usa carga en lote (sin N+1 secuencial) cuando el repositorio expone listByConversationIds y getAutomationStatesByCaseIds", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const baseCaseRepo = new CaseRepositoryFake();
    const departmentRepo = new DepartmentRepositoryFake();

    const deptSoporte = departmentRepo.seed({ slug: "soporte", name: "Soporte" });
    const conv1 = conversationRepo.createOpen({ id: "conv-b1", waPhone: "+593980000001", status: "open" });
    const conv2 = conversationRepo.createOpen({ id: "conv-b2", waPhone: "+593980000002", status: "open" });
    messageRepo.seedText(conv1.id, "Hola 1");
    messageRepo.seedText(conv2.id, "Hola 2");

    const { case: c1 } = await baseCaseRepo.create({
      conversationId: conv1.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: deptSoporte.id,
      context: emptyContextFor("SUPPORT_INTERNET"),
      initialState: "START",
      expiresAt: null,
    });
    const { case: c2 } = await baseCaseRepo.create({
      conversationId: conv2.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: deptSoporte.id,
      context: emptyContextFor("SUPPORT_INTERNET"),
      initialState: "START",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conv1.id, c1.id);
    await conversationRepo.setActiveCaseId(conv2.id, c2.id);

    let singleCalls = 0;
    let batchCasesCalls = 0;
    let batchAutomationCalls = 0;

    const batchCaseRepo = Object.create(baseCaseRepo) as CaseRepositoryFake & {
      listByConversationIds: (ids: string[]) => Promise<Map<string, Awaited<ReturnType<CaseRepositoryFake["listByConversation"]>>>>;
      getAutomationStatesByCaseIds: (ids: string[]) => Promise<Map<string, NonNullable<Awaited<ReturnType<CaseRepositoryFake["getAutomationState"]>>>>>;
    };
    batchCaseRepo.listByConversation = async (id: string) => {
      singleCalls += 1;
      return baseCaseRepo.listByConversation(id);
    };
    batchCaseRepo.listByConversationIds = async (ids: string[]) => {
      batchCasesCalls += 1;
      const map = new Map<string, Awaited<ReturnType<CaseRepositoryFake["listByConversation"]>>>();
      for (const id of ids) {
        map.set(id, await baseCaseRepo.listByConversation(id));
      }
      return map;
    };
    batchCaseRepo.getAutomationStatesByCaseIds = async (ids: string[]) => {
      batchAutomationCalls += 1;
      const map = new Map<string, NonNullable<Awaited<ReturnType<CaseRepositoryFake["getAutomationState"]>>>>();
      for (const id of ids) {
        const st = await baseCaseRepo.getAutomationState(id);
        if (st) map.set(id, st);
      }
      return map;
    };

    const listUseCase = new ListConversationsUseCase(
      conversationRepo,
      messageRepo,
      batchCaseRepo,
      undefined,
      departmentRepo,
    );

    const items = await listUseCase.execute({});
    expect(items).toHaveLength(2);
    expect(batchCasesCalls).toBe(1);
    expect(batchAutomationCalls).toBe(1);
    expect(singleCalls).toBe(0);
  });

  it("expone automation.disabledReason dentro de activeCase para distinguir motivos de escalación en UI", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const caseRepo = new CaseRepositoryFake();

    const conv = conversationRepo.createOpen({
      id: "conv-reason-1",
      waPhone: "+593987654321",
      status: "open",
    });
    messageRepo.seedText(conv.id, "Necesito ayuda");

    const { case: escalatedCase } = await caseRepo.create({
      conversationId: conv.id,
      workflowType: "GENERAL_INQUIRY",
      departmentId: "dept-general",
      context: emptyContextFor("GENERAL_INQUIRY"),
      initialState: "TRIAGE",
      expiresAt: null,
    });
    await caseRepo.setAutomationEnabled(escalatedCase.id, false, { reason: "AI_ERROR" });
    await conversationRepo.setActiveCaseId(conv.id, escalatedCase.id);

    const listUseCase = new ListConversationsUseCase(conversationRepo, messageRepo, caseRepo);
    const items = await listUseCase.execute({});

    expect(items).toHaveLength(1);
    expect(items[0]!.activeCase?.automationEnabled).toBe(false);
    expect(items[0]!.activeCase?.disabledReason).toBe("AI_ERROR");
  });
});
