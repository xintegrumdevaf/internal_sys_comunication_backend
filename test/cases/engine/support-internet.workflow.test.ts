import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import type { CaseContext } from "../../../src/core/modules/cases/domain/contexts/case-context";
import { N8nGatewayFake } from "../fakes";

const emptyContext: CaseContext = { workflowType: "SUPPORT_INTERNET", data: {} };

function contextWithNationalId(nationalId: string): CaseContext {
  return {
    workflowType: "SUPPORT_INTERNET",
    data: { client: { nationalId, fullName: "" } },
  };
}

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

describe("supportInternetWorkflow (docs/spec/02_STATE_MACHINE.md §3 + §13)", () => {
  it("VALIDATE_CLIENT pide cedula sin llamar n8n cuando no hay nationalId", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({ success: true, result: { found: false, contractNumbers: 0, contracts: [] } }),
    });

    const outcome = await engine.step("SUPPORT_INTERNET", baseInput("VALIDATE_CLIENT", emptyContext, gateway));

    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_CLIENT" });
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(0);
  });

  it("VALIDATE_CLIENT re-pregunta la cedula cuando no se encuentra contrato (found:false)", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({ success: true, result: { found: false, contractNumbers: 0, contracts: [] } }),
    });

    const outcome = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("VALIDATE_CLIENT", contextWithNationalId("999"), gateway),
    );

    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_CLIENT" });
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(1);
  });

  it("VALIDATE_CLIENT pide desambiguacion cuando hay mas de un contrato", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 2,
          contracts: [
            { id: "1", name: "Juan", address: "Av. Amazonas", router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1" } },
            { id: "1", name: "Juan", address: "Av. Colon", router: { sector: "pifo", olt_name: "olt2", pon: "1", serial: "S2" } },
          ],
        },
      }),
    });

    const outcome = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("VALIDATE_CLIENT", contextWithNationalId("1"), gateway),
    );
    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_DISAMBIGUATE" });
  });

  it("cliente validado sin deuda avanza a DIAGNOSTIC, traduciendo router.olt_name (snake_case) a oltName", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [
            { id: "123", name: "Juan", router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1" } },
          ],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false } }),
    });

    const step1 = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("VALIDATE_CLIENT", contextWithNationalId("123"), gateway),
    );
    expect(step1.type).toBe("CONTINUE");
    if (step1.type !== "CONTINUE") throw new Error("unreachable");
    expect(step1.nextState).toBe("CHECK_BALANCE");
    if (step1.context.workflowType !== "SUPPORT_INTERNET") throw new Error("unreachable");
    expect(step1.context.data.contract?.oltName).toBe("olt1");

    const step2 = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("CHECK_BALANCE", step1.context, gateway),
    );
    expect(step2).toMatchObject({ type: "CONTINUE", nextState: "DIAGNOSTIC" });
  });

  it("cliente con deuda: CHECK_BALANCE -> RESPOND_DEBT -> COMPLETED", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: true, debt: 25 } }),
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
      DIAGNOSTIC: () => ({ success: true, result: { status: "WAITING_USER", question: "¿La luz ONU esta roja?" } }),
      CONTINUE_DIAGNOSTIC: () => ({ success: true, result: { status: "COMPLETED", diagnostic: "ONU_REINICIADA" } }),
    });

    const step1 = await engine.step("SUPPORT_INTERNET", baseInput("DIAGNOSTIC", emptyContext, gateway));
    expect(step1).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_DIAGNOSTIC" });
    if (step1.type !== "WAITING_USER") throw new Error("unreachable");

    const step2 = await engine.step(
      "SUPPORT_INTERNET",
      {
        ...baseInput("WAITING_USER_DIAGNOSTIC", step1.context, gateway),
        text: "si, esta roja",
        entities: { answer: "si, esta roja" },
      },
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
      DIAGNOSTIC: () => ({ success: true, result: { status: "ESCALATED" } }),
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

    const outcome = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("VALIDATE_CLIENT", contextWithNationalId("1"), gateway),
    );
    expect(outcome).toMatchObject({ type: "ESCALATED", reason: "timeout" });
  });

  it("WAITING_USER_DISAMBIGUATE selecciona contrato por address", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({});
    const context: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1", fullName: "Juan" },
        pendingContracts: [
          {
            id: "1",
            name: "Juan",
            address: "Av. Amazonas 100",
            sector: "pomasqui",
            oltName: "olt1",
            pon: "3",
            serial: "S1",
          },
          {
            id: "2",
            name: "Juan",
            address: "Av. Colon 200",
            sector: "pifo",
            oltName: "olt2",
            pon: "1",
            serial: "S2",
          },
        ],
      },
    };

    const outcome = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("WAITING_USER_DISAMBIGUATE", context, gateway),
      entities: { address: "Amazonas" },
    });
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "CHECK_BALANCE" });
    if (outcome.type !== "CONTINUE" || outcome.context.workflowType !== "SUPPORT_INTERNET") {
      throw new Error("unreachable");
    }
    expect(outcome.context.data.contract?.oltName).toBe("olt1");
  });
});
