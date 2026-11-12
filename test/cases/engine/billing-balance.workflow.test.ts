import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import {
  billingBalanceWorkflow,
  createBillingBalanceWorkflow,
} from "../../../src/core/modules/cases/application/engine/definitions/billing-balance.workflow";
import type { RagService } from "../../../src/core/modules/ai/application/services/rag.service";
import type { CaseContext } from "../../../src/core/modules/cases/domain/contexts/case-context";
import { N8nGatewayFake } from "../fakes";

const emptyContext: CaseContext = {
  workflowType: "BILLING_BALANCE",
  data: { purpose: "balance" },
};

function baseInput(currentState: string, context: CaseContext, gateway: N8nGatewayFake) {
  return {
    caseId: "case-bill",
    conversationId: "conv-bill",
    correlationId: "corr-bill",
    currentState,
    context,
    gateway,
  };
}

describe("billingBalanceWorkflow (Etapa 8)", () => {
  it("sin nationalId pide WAITING_USER_CLIENT sin llamar n8n", async () => {
    const engine = new WorkflowEngine([billingBalanceWorkflow]);
    const gateway = new N8nGatewayFake({});
    const outcome = await engine.step(
      "BILLING_BALANCE",
      baseInput("VALIDATE_CLIENT", emptyContext, gateway),
    );
    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_CLIENT" });
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(0);
  });

  it("consulta saldo con deuda: CHECK_BALANCE → RESPOND_DEBT_WITH_OPTIONS → COMPLETED", async () => {
    const engine = new WorkflowEngine([billingBalanceWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [{ id: "1", name: "Ana", router: { sector: "a", olt_name: "o", pon: "1", serial: "S" } }],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: true, debt: 45.5 } }),
    });

    const ctx: CaseContext = {
      workflowType: "BILLING_BALANCE",
      data: { purpose: "balance", client: { nationalId: "1", fullName: "" } },
    };
    const step1 = await engine.step("BILLING_BALANCE", baseInput("VALIDATE_CLIENT", ctx, gateway));
    expect(step1).toMatchObject({ type: "CONTINUE", nextState: "CHECK_BALANCE" });
    if (step1.type !== "CONTINUE") throw new Error("unreachable");

    const step2 = await engine.step(
      "BILLING_BALANCE",
      baseInput("CHECK_BALANCE", step1.context, gateway),
    );
    expect(step2).toMatchObject({ type: "CONTINUE", nextState: "RESPOND_DEBT_WITH_OPTIONS" });
    if (step2.type !== "CONTINUE") throw new Error("unreachable");
    if (step2.context.workflowType !== "BILLING_BALANCE") throw new Error("unreachable");
    expect(step2.context.data.balance).toEqual({ hasDebt: true, amount: 45.5 });

    const step3 = await engine.step(
      "BILLING_BALANCE",
      baseInput("RESPOND_DEBT_WITH_OPTIONS", step2.context, gateway),
    );
    expect(step3.type).toBe("COMPLETED");
  });

  it("consulta saldo sin deuda: CHECK_BALANCE → RESPOND_NO_DEBT → COMPLETED", async () => {
    const engine = new WorkflowEngine([billingBalanceWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [{ id: "1", name: "Ana", router: { sector: "a", olt_name: "o", pon: "1", serial: "S" } }],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: false, debt: 0 } }),
    });

    const ctx: CaseContext = {
      workflowType: "BILLING_BALANCE",
      data: { purpose: "balance", client: { nationalId: "1", fullName: "" } },
    };
    const step1 = await engine.step("BILLING_BALANCE", baseInput("VALIDATE_CLIENT", ctx, gateway));
    if (step1.type !== "CONTINUE") throw new Error("unreachable");

    const step2 = await engine.step(
      "BILLING_BALANCE",
      baseInput("CHECK_BALANCE", step1.context, gateway),
    );
    expect(step2).toMatchObject({ type: "CONTINUE", nextState: "RESPOND_NO_DEBT" });
    if (step2.type !== "CONTINUE") throw new Error("unreachable");
    if (step2.context.workflowType !== "BILLING_BALANCE") throw new Error("unreachable");
    expect(step2.context.data.balance).toEqual({ hasDebt: false, amount: 0 });

    const step3 = await engine.step(
      "BILLING_BALANCE",
      baseInput("RESPOND_NO_DEBT", step2.context, gateway),
    );
    expect(step3.type).toBe("COMPLETED");
  });

  it("record_payment con amount+reference llama RECORD_PAYMENT sin WAITING_RECEIPT", async () => {
    const engine = new WorkflowEngine([billingBalanceWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [{ id: "1", name: "Ana", router: { sector: "a", olt_name: "o", pon: "1", serial: "S" } }],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: true, debt: 20 } }),
      RECORD_PAYMENT: () => ({ success: true, result: { recorded: true } }),
    });

    const ctx: CaseContext = {
      workflowType: "BILLING_BALANCE",
      data: {
        purpose: "record_payment",
        client: { nationalId: "1", fullName: "" },
        payment: { amount: 20, reference: "ABC123", status: "PENDING" },
      },
    };

    let outcome = await engine.step("BILLING_BALANCE", baseInput("VALIDATE_CLIENT", ctx, gateway));
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "CHECK_BALANCE" });
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");

    outcome = await engine.step(
      "BILLING_BALANCE",
      baseInput("CHECK_BALANCE", outcome.context, gateway),
    );
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "RECORD_PAYMENT" });
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");

    outcome = await engine.step(
      "BILLING_BALANCE",
      baseInput("RECORD_PAYMENT", outcome.context, gateway),
    );
    expect(outcome.type).toBe("COMPLETED");
    expect(gateway.actionsCalledFor("RECORD_PAYMENT")).toBe(1);
    if (outcome.context.workflowType !== "BILLING_BALANCE") throw new Error("unreachable");
    expect(outcome.context.data.payment?.status).toBe("RECORDED");
  });

  it("record_payment sin datos pide WAITING_USER_RECEIPT", async () => {
    const engine = new WorkflowEngine([billingBalanceWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [{ id: "1", name: "Ana", router: { sector: "a", olt_name: "o", pon: "1", serial: "S" } }],
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: true, debt: 10 } }),
    });

    const ctx: CaseContext = {
      workflowType: "BILLING_BALANCE",
      data: { purpose: "record_payment", client: { nationalId: "1", fullName: "" } },
    };

    let outcome = await engine.step("BILLING_BALANCE", baseInput("VALIDATE_CLIENT", ctx, gateway));
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");
    outcome = await engine.step(
      "BILLING_BALANCE",
      baseInput("CHECK_BALANCE", outcome.context, gateway),
    );
    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_RECEIPT" });
    expect(gateway.actionsCalledFor("RECORD_PAYMENT")).toBe(0);
  });

  it("payment_methods sin RAG o sin respuesta: escala a Facturación en lugar de entregar datos quemados", async () => {
    const engine = new WorkflowEngine([billingBalanceWorkflow]);
    const gateway = new N8nGatewayFake({});

    const ctx: CaseContext = {
      workflowType: "BILLING_BALANCE",
      data: { purpose: "payment_methods" },
    };

    const step1 = await engine.step("BILLING_BALANCE", baseInput("VALIDATE_CLIENT", ctx, gateway));
    expect(step1).toMatchObject({ type: "CONTINUE", nextState: "RESPOND_PAYMENT_METHODS" });
    if (step1.type !== "CONTINUE") throw new Error("unreachable");

    const step2 = await engine.step(
      "BILLING_BALANCE",
      baseInput("RESPOND_PAYMENT_METHODS", step1.context, gateway),
    );
    expect(step2).toMatchObject({
      type: "ESCALATED",
      reason: "UNANSWERED_PAYMENT_METHODS",
    });
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(0);
  });

  it("payment_methods con RAG: consulta RagService dinámicamente y guarda paymentMethodsInfo en context", async () => {
    const ragServiceMock = {
      query: async () => ({
        found: true,
        answer: "Cuentas RAG: Banco Internacional Cta. 555666",
        confidenceScore: 0.9,
        sources: ["cuentas.pdf"],
        retrievedChunks: [],
        executionTimeMs: 10,
      }),
    } as unknown as RagService;

    const dynamicWorkflow = createBillingBalanceWorkflow(ragServiceMock);
    const engine = new WorkflowEngine([dynamicWorkflow]);
    const gateway = new N8nGatewayFake({});

    const ctx: CaseContext = {
      workflowType: "BILLING_BALANCE",
      data: { purpose: "payment_methods" },
    };

    const step1 = await engine.step("BILLING_BALANCE", baseInput("RESPOND_PAYMENT_METHODS", ctx, gateway));
    expect(step1).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_RECEIPT" });
    if (step1.type !== "WAITING_USER" || step1.context.workflowType !== "BILLING_BALANCE") throw new Error("unreachable");
    expect(step1.context.data.paymentMethodsInfo).toBe("Cuentas RAG: Banco Internacional Cta. 555666");
  });

  it("si el cliente estaba en WAITING_USER_CLIENT (esperando cédula para saldo) y luego pide payment_methods, conmuta a RESPOND_PAYMENT_METHODS", async () => {
    const ragServiceMock = {
      query: async () => ({
        found: true,
        answer: "Cuentas RAG: Banco Pichincha 12345",
        confidenceScore: 0.9,
        sources: ["cuentas.pdf"],
        retrievedChunks: [],
        executionTimeMs: 10,
      }),
    } as unknown as RagService;

    const dynamicWorkflow = createBillingBalanceWorkflow(ragServiceMock);
    const engine = new WorkflowEngine([dynamicWorkflow]);
    const gateway = new N8nGatewayFake({});

    const ctx: CaseContext = {
      workflowType: "BILLING_BALANCE",
      data: { purpose: "balance" },
    };

    const step = await engine.step("BILLING_BALANCE", {
      ...baseInput("WAITING_USER_CLIENT", ctx, gateway),
      entities: { billingPurpose: "payment_methods" },
    });

    expect(step).toMatchObject({ type: "CONTINUE", nextState: "RESPOND_PAYMENT_METHODS" });
  });
});