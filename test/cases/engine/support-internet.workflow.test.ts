import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import type { CaseContext } from "../../../src/core/modules/cases/domain/contexts/case-context";
import { N8nGatewayFake } from "../fakes";

const emptyContext: CaseContext = { workflowType: "SUPPORT_INTERNET", data: {} };

function baseInput(currentState: string, context: CaseContext, gateway: N8nGatewayFake) {
  return {
    caseId: "case-1",
    conversationId: "conv-1",
    correlationId: "corr-1",
    currentState,
    context,
    gateway,
  };
}

describe("supportInternetWorkflow (docs/spec/02_STATE_MACHINE.md §3)", () => {
  it("VALIDATE_CLIENT pide datos del usuario cuando faltan (needsInput)", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({ success: true, result: { needsInput: true } }),
    });

    const outcome = await engine.step("SUPPORT_INTERNET", baseInput("VALIDATE_CLIENT", emptyContext, gateway));

    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_CLIENT" });
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(1);
  });

  it("cliente validado sin deuda avanza a DIAGNOSTIC", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: { client: { nationalId: "123", fullName: "Juan" }, contract: { id: "c1", sector: "pomasqui", oltName: "olt1", pon: "3", serial: "S1", router: "r1" } },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
    });

    const step1 = await engine.step("SUPPORT_INTERNET", baseInput("VALIDATE_CLIENT", emptyContext, gateway));
    expect(step1.type).toBe("CONTINUE");
    if (step1.type !== "CONTINUE") throw new Error("unreachable");
    expect(step1.nextState).toBe("CHECK_BALANCE");

    const step2 = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("CHECK_BALANCE", step1.context, gateway),
    );
    expect(step2).toMatchObject({ type: "CONTINUE", nextState: "DIAGNOSTIC" });
  });

  it("cliente con deuda: CHECK_BALANCE -> RESPOND_DEBT -> COMPLETED", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: true, amount: 25 } }),
    });

    const step1 = await engine.step("SUPPORT_INTERNET", baseInput("CHECK_BALANCE", emptyContext, gateway));
    expect(step1).toMatchObject({ type: "CONTINUE", nextState: "RESPOND_DEBT" });
    if (step1.type !== "CONTINUE") throw new Error("unreachable");

    const step2 = await engine.step("SUPPORT_INTERNET", baseInput("RESPOND_DEBT", step1.context, gateway));
    expect(step2.type).toBe("COMPLETED");
  });

  it("DIAGNOSTIC pide info -> WAITING_USER_DIAGNOSTIC, y al continuar llama CONTINUE_DIAGNOSTIC (nunca VALIDATE_CLIENT/CHECK_BALANCE)", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      DIAGNOSTIC: () => ({ success: true, result: { resolved: false, question: "¿La luz ONU esta roja?" } }),
      CONTINUE_DIAGNOSTIC: () => ({ success: true, result: { resolved: true, result: "Reinicio de ONU resolvio el problema" } }),
    });

    const step1 = await engine.step("SUPPORT_INTERNET", baseInput("DIAGNOSTIC", emptyContext, gateway));
    expect(step1).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_DIAGNOSTIC" });
    if (step1.type !== "WAITING_USER") throw new Error("unreachable");

    const step2 = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("WAITING_USER_DIAGNOSTIC", step1.context, gateway),
    );
    expect(step2.type).toBe("COMPLETED");

    // Regla dura: retomar desde WAITING_USER_DIAGNOSTIC nunca vuelve a VALIDATE_CLIENT/CHECK_BALANCE.
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(0);
    expect(gateway.actionsCalledFor("CHECK_BALANCE")).toBe(0);
    expect(gateway.actionsCalledFor("DIAGNOSTIC")).toBe(1);
    expect(gateway.actionsCalledFor("CONTINUE_DIAGNOSTIC")).toBe(1);
  });

  it("DIAGNOSTIC no resoluble automaticamente escala", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      DIAGNOSTIC: () => ({ success: true, result: { unresolvable: true } }),
    });

    const outcome = await engine.step("SUPPORT_INTERNET", baseInput("DIAGNOSTIC", emptyContext, gateway));
    expect(outcome.type).toBe("ESCALATED");
  });

  it("un error del gateway tambien escala el paso", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: false,
        error: { type: "EXTERNAL_SERVICE_ERROR", message: "timeout", retryable: true },
      }),
    });

    const outcome = await engine.step("SUPPORT_INTERNET", baseInput("VALIDATE_CLIENT", emptyContext, gateway));
    expect(outcome).toMatchObject({ type: "ESCALATED", reason: "timeout" });
  });
});
