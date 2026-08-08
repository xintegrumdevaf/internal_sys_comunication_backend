import { describe, expect, it } from "vitest";
import { AdvanceCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/advance-case.use-case";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import { CaseRepositoryFake, N8nGatewayFake, WorkflowExecutionRepositoryFake } from "../fakes";
import { ConversationRepositoryFake } from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

function buildUseCase(gateway: N8nGatewayFake) {
  const caseRepo = new CaseRepositoryFake();
  const workflowExecutionRepo = new WorkflowExecutionRepositoryFake();
  const conversationRepo = new ConversationRepositoryFake();
  const engine = new WorkflowEngine([supportInternetWorkflow]);
  const advanceCase = new AdvanceCaseUseCase({
    caseRepo,
    workflowExecutionRepo,
    conversationRepo,
    engine,
    gateway,
    logger: silentLogger,
  });
  return { caseRepo, workflowExecutionRepo, conversationRepo, engine, advanceCase };
}

describe("AdvanceCaseUseCase (docs/spec/05_BUILD_PLAN.md Etapa 2)", () => {
  it("inicia el workflow y encadena pasos sin intervencion del usuario hasta necesitar un dato", async () => {
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({ success: true, result: { client: { nationalId: "1", fullName: "Ana" } } }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
      DIAGNOSTIC: () => ({ success: true, result: { resolved: false, question: "¿ONU encendida?" } }),
    });
    const { caseRepo, conversationRepo, advanceCase } = buildUseCase(gateway);

    const conversation = conversationRepo.createOpen();
    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await conversationRepo.setActiveCaseId(conversation.id, created.id);

    const result = await advanceCase.execute({ caseId: created.id, correlationId: "corr-1" });

    expect(result.status).toBe("WAITING_USER");
    const aggregate = await caseRepo.findById(created.id);
    expect(aggregate?.workflowInstance.currentState).toBe("WAITING_USER_DIAGNOSTIC");
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(1);
    expect(gateway.actionsCalledFor("CHECK_BALANCE")).toBe(1);
    expect(gateway.actionsCalledFor("DIAGNOSTIC")).toBe(1);

    const conversationAfter = await conversationRepo.findById(conversation.id);
    expect(conversationAfter?.activeCaseId).toBe(created.id);
  });

  it("continua desde WAITING_USER_DIAGNOSTIC sin volver a VALIDATE_CLIENT/CHECK_BALANCE", async () => {
    const gateway = new N8nGatewayFake({
      CONTINUE_DIAGNOSTIC: () => ({ success: true, result: { resolved: true, result: "ONU reiniciada" } }),
    });
    const { caseRepo, conversationRepo, advanceCase } = buildUseCase(gateway);

    const conversation = conversationRepo.createOpen();
    const { case: created, workflowInstance } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: { diagnostic: { status: "PENDING", lastQuestion: "¿ONU encendida?" } } },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    // Simula que el caso quedo esperando la respuesta del usuario en el diagnostico.
    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: workflowInstance.version,
      status: "WAITING_USER",
      context: created.context,
      currentState: "WAITING_USER_DIAGNOSTIC",
      expiresAt: created.expiresAt,
    });

    const result = await advanceCase.execute({ caseId: created.id, correlationId: "corr-2" });

    expect(result.status).toBe("COMPLETED");
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(0);
    expect(gateway.actionsCalledFor("CHECK_BALANCE")).toBe(0);
    expect(gateway.actionsCalledFor("CONTINUE_DIAGNOSTIC")).toBe(1);

    const conversationAfter = await conversationRepo.findById(conversation.id);
    expect(conversationAfter?.activeCaseId).toBeNull();
  });

  it("completa un caso sin deuda y con diagnostico resuelto de una sola pasada", async () => {
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({ success: true, result: { client: { nationalId: "1", fullName: "Ana" } } }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
      DIAGNOSTIC: () => ({ success: true, result: { resolved: true, result: "Reinicio de ONU resolvio el problema" } }),
    });
    const { caseRepo, conversationRepo, advanceCase } = buildUseCase(gateway);

    const conversation = conversationRepo.createOpen();
    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const result = await advanceCase.execute({ caseId: created.id, correlationId: "corr-3" });

    expect(result.status).toBe("COMPLETED");
  });

  it("escala y deshabilita la automatizacion cuando el diagnostico no es resoluble", async () => {
    const gateway = new N8nGatewayFake({
      DIAGNOSTIC: () => ({ success: true, result: { unresolvable: true } }),
    });
    const { caseRepo, conversationRepo, advanceCase } = buildUseCase(gateway);

    const conversation = conversationRepo.createOpen();
    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "DIAGNOSTIC",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await conversationRepo.setActiveCaseId(conversation.id, created.id);

    const result = await advanceCase.execute({ caseId: created.id, correlationId: "corr-4" });

    expect(result.status).toBe("ESCALATED");
    const automation = await caseRepo.getAutomationState(created.id);
    expect(automation?.enabled).toBe(false);
    const conversationAfter = await conversationRepo.findById(conversation.id);
    expect(conversationAfter?.activeCaseId).toBeNull();
  });
});
