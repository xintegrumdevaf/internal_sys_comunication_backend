import { describe, expect, it } from "vitest";
import { ComposeCustomerReplyUseCase } from "../../src/core/modules/ai/application/use-cases/compose-customer-reply.use-case";
import { FakeAIProvider } from "../../src/core/modules/ai/infrastructure/fake/fake-ai.provider";
import { resolveReplyTemplate } from "../../src/core/modules/cases/application/services/resolve-reply-template";
import { supportInternetWorkflow } from "../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import type { CaseContext } from "../../src/core/modules/cases/domain/contexts/case-context";

describe("composeReply — monto de deuda (06_AI_PROMPTS.md §4)", () => {
  it("resolveReplyTemplate COMPLETED con deuda usa RESPOND_DEBT e incluye debt formateado", () => {
    const context: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        balance: { hasDebt: true, amount: 45.5 },
      },
    };
    const resolved = resolveReplyTemplate({
      definition: supportInternetWorkflow,
      outcome: { type: "COMPLETED", context },
      context,
    });

    expect(resolved.action).toBe("RESPOND_DEBT");
    expect(resolved.resultVars.debt).toBe("45.50");
    expect(resolved.templateHint).toContain("{{debt}}");
  });

  it("stepOutcome.result.debt=45.50 → el mensaje final contiene el monto (no frase generica)", async () => {
    const fake = new FakeAIProvider();
    // Simula LLM que omite el monto (bug observado en prueba manual).
    fake.composeImpl = async () =>
      "Revisé tu cuenta y encontré un saldo pendiente. Cuando regularices el pago podemos seguir con el soporte técnico.";

    const compose = new ComposeCustomerReplyUseCase(fake);
    const body = await compose.execute({
      caseId: "case-debt",
      workflowType: "SUPPORT_INTERNET",
      stepOutcome: {
        action: "RESPOND_DEBT",
        status: "COMPLETED",
        result: { hasDebt: true, debt: "45.50", amount: 45.5 },
      },
      templateHint:
        "Detectamos un saldo pendiente de {{debt}} en tu cuenta. Cuando regularices el pago podemos continuar con el soporte técnico.",
    });

    expect(body).toMatch(/45\.50/);
    expect(body.toLowerCase()).not.toBe(
      "revisé tu cuenta y encontré un saldo pendiente. cuando regularices el pago podemos seguir con el soporte técnico.",
    );
  });

  it("si el LLM incluye el monto, se conserva la naturalizacion", async () => {
    const fake = new FakeAIProvider();
    fake.composeImpl = async () =>
      "Revisé tu cuenta y encontré un saldo pendiente de $45.50. Cuando pagues podemos seguir con el soporte.";

    const compose = new ComposeCustomerReplyUseCase(fake);
    const body = await compose.execute({
      caseId: "case-debt-2",
      workflowType: "SUPPORT_INTERNET",
      stepOutcome: {
        action: "RESPOND_DEBT",
        status: "COMPLETED",
        result: { hasDebt: true, debt: "45.50" },
      },
      templateHint: "Detectamos un saldo pendiente de {{debt}} en tu cuenta.",
    });

    expect(body).toContain("45.50");
    expect(body).toContain("Revisé tu cuenta");
  });
});
