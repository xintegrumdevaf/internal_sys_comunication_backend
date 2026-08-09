import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { salesPackagesWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/sales-packages.workflow";
import type { CaseContext } from "../../../src/core/modules/cases/domain/contexts/case-context";
import { N8nGatewayFake } from "../fakes";

function baseInput(currentState: string, context: CaseContext, gateway: N8nGatewayFake, text?: string) {
  return {
    caseId: "case-sales",
    conversationId: "conv-sales",
    correlationId: "corr-sales",
    currentState,
    context,
    gateway,
    text,
  };
}

describe("salesPackagesWorkflow (Etapa 8)", () => {
  it("consulta paquetes: QUERY_KNOWLEDGE_BASE → RESPOND_OFFER → COMPLETED", async () => {
    const engine = new WorkflowEngine([salesPackagesWorkflow]);
    const gateway = new N8nGatewayFake({
      QUERY_KNOWLEDGE_BASE: () => ({
        success: true,
        result: {
          found: true,
          answer: "Tenemos plan 500 Mbps por $25/mes.",
          planId: "p500",
          price: 25,
          speed: "500 Mbps",
        },
      }),
    });

    const ctx: CaseContext = {
      workflowType: "SALES_PACKAGES",
      data: { purpose: "packages", requestedSpeed: "500 Mbps" },
    };

    let outcome = await engine.step(
      "SALES_PACKAGES",
      baseInput("COLLECT_PREFERENCE", ctx, gateway, "quiero 500 megas"),
    );
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "QUERY_PACKAGES" });
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");

    outcome = await engine.step(
      "SALES_PACKAGES",
      baseInput("QUERY_PACKAGES", outcome.context, gateway),
    );
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "RESPOND_OFFER" });
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");

    outcome = await engine.step(
      "SALES_PACKAGES",
      baseInput("RESPOND_OFFER", outcome.context, gateway),
    );
    expect(outcome.type).toBe("COMPLETED");
    expect(gateway.actionsCalledFor("QUERY_KNOWLEDGE_BASE")).toBe(1);
  });

  it("sales.upgrade tras oferta espera confirmacion y escala a ventas", async () => {
    const engine = new WorkflowEngine([salesPackagesWorkflow]);
    const gateway = new N8nGatewayFake({
      QUERY_KNOWLEDGE_BASE: () => ({
        success: true,
        result: { found: true, answer: "Plan 300 Mbps $18", planId: "p300", price: 18 },
      }),
    });

    const ctx: CaseContext = {
      workflowType: "SALES_PACKAGES",
      data: { purpose: "upgrade", requestedSpeed: "300 Mbps" },
    };

    let outcome = await engine.step(
      "SALES_PACKAGES",
      baseInput("COLLECT_PREFERENCE", ctx, gateway, "quiero mejorar mi plan a 300"),
    );
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");
    outcome = await engine.step(
      "SALES_PACKAGES",
      baseInput("QUERY_PACKAGES", outcome.context, gateway),
    );
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");
    outcome = await engine.step(
      "SALES_PACKAGES",
      baseInput("RESPOND_OFFER", outcome.context, gateway),
    );
    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_UPGRADE" });
    if (outcome.type !== "WAITING_USER") throw new Error("unreachable");

    outcome = await engine.step(
      "SALES_PACKAGES",
      {
        ...baseInput("WAITING_USER_UPGRADE", outcome.context, gateway, "sí, por favor"),
        entities: { answer: "sí, por favor" },
      },
    );
    expect(outcome.type).toBe("ESCALATED");
  });

  it("sin resultados en knowledge base escala", async () => {
    const engine = new WorkflowEngine([salesPackagesWorkflow]);
    const gateway = new N8nGatewayFake({
      QUERY_KNOWLEDGE_BASE: () => ({
        success: true,
        result: { found: false },
      }),
    });

    const ctx: CaseContext = {
      workflowType: "SALES_PACKAGES",
      data: { purpose: "packages" },
    };

    let outcome = await engine.step(
      "SALES_PACKAGES",
      baseInput("COLLECT_PREFERENCE", ctx, gateway, "qué planes tienen"),
    );
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");
    outcome = await engine.step(
      "SALES_PACKAGES",
      baseInput("QUERY_PACKAGES", outcome.context, gateway),
    );
    expect(outcome.type).toBe("ESCALATED");
  });
});
