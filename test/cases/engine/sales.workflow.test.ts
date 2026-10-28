import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import {
  createSalesWorkflow,
  salesWorkflow,
} from "../../../src/core/modules/cases/application/engine/definitions/sales.workflow";
import type { CaseContext } from "../../../src/core/modules/cases/domain/contexts/case-context";
import type { SalesContext } from "../../../src/core/modules/cases/domain/contexts/sales.context";
import { CoverageService } from "../../../src/core/modules/coverage/application/services/coverage.service";
import { KmlParserService } from "../../../src/core/modules/coverage/application/services/kml-parser.service";
import type { CoverageZone } from "../../../src/core/modules/coverage/domain/coverage-zone.entity";
import type { CoverageRepositoryPort } from "../../../src/core/modules/coverage/domain/coverage.repository.port";
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

describe("salesWorkflow", () => {
  it("consulta planes: QUERY_KNOWLEDGE_BASE → RESPOND_OFFER → COMPLETED", async () => {
    const engine = new WorkflowEngine([salesWorkflow]);
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
      workflowType: "SALES",
      data: { purpose: "sales", requestedSpeed: "500 Mbps" },
    };

    let outcome = await engine.step(
      "SALES",
      baseInput("COLLECT_PREFERENCE", ctx, gateway, "quiero 500 megas"),
    );
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "QUERY_PLANS" });
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");

    outcome = await engine.step(
      "SALES",
      baseInput("QUERY_PLANS", outcome.context, gateway),
    );
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "RESPOND_OFFER" });
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");

    outcome = await engine.step(
      "SALES",
      baseInput("RESPOND_OFFER", outcome.context, gateway),
    );
    expect(outcome.type).toBe("COMPLETED");
    expect(gateway.actionsCalledFor("QUERY_KNOWLEDGE_BASE")).toBe(1);
  });

  it("sales.upgrade tras oferta espera confirmacion y escala a ventas", async () => {
    const engine = new WorkflowEngine([salesWorkflow]);
    const gateway = new N8nGatewayFake({
      QUERY_KNOWLEDGE_BASE: () => ({
        success: true,
        result: { found: true, answer: "Plan 300 Mbps $18", planId: "p300", price: 18 },
      }),
    });

    const ctx: CaseContext = {
      workflowType: "SALES",
      data: { purpose: "upgrade", requestedSpeed: "300 Mbps" },
    };

    let outcome = await engine.step(
      "SALES",
      baseInput("COLLECT_PREFERENCE", ctx, gateway, "quiero mejorar mi plan a 300"),
    );
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");
    outcome = await engine.step(
      "SALES",
      baseInput("QUERY_PLANS", outcome.context, gateway),
    );
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");
    outcome = await engine.step(
      "SALES",
      baseInput("RESPOND_OFFER", outcome.context, gateway),
    );
    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_UPGRADE" });
    if (outcome.type !== "WAITING_USER") throw new Error("unreachable");

    outcome = await engine.step(
      "SALES",
      {
        ...baseInput("WAITING_USER_UPGRADE", outcome.context, gateway, "sí, por favor"),
        entities: { answer: "sí, por favor" },
      },
    );
    expect(outcome.type).toBe("ESCALATED");
  });

  it("sin resultados en knowledge base escala", async () => {
    const engine = new WorkflowEngine([salesWorkflow]);
    const gateway = new N8nGatewayFake({
      QUERY_KNOWLEDGE_BASE: () => ({
        success: true,
        result: { found: false },
      }),
    });

    const ctx: CaseContext = {
      workflowType: "SALES",
      data: { purpose: "sales" },
    };

    let outcome = await engine.step(
      "SALES",
      baseInput("COLLECT_PREFERENCE", ctx, gateway, "qué planes tienen"),
    );
    if (outcome.type !== "CONTINUE") throw new Error("unreachable");
    outcome = await engine.step(
      "SALES",
      baseInput("QUERY_PLANS", outcome.context, gateway),
    );
    expect(outcome.type).toBe("ESCALATED");
  });

  describe("Flujo de ventas con CoverageService (KML)", () => {
    class FakeCoverageRepo implements CoverageRepositoryPort {
      constructor(private zones: CoverageZone[] = []) {}
      async replaceAll(z: CoverageZone[]) { this.zones = z; }
      async findAllActive() { return this.zones; }
      async count() { return this.zones.length; }
    }

    const chillogalloZone: CoverageZone = {
      name: "CHILLOGALLO",
      city: "Quito",
      coordinates: [
        [-78.56, -0.27],
        [-78.55, -0.27],
        [-78.55, -0.28],
        [-78.56, -0.28],
        [-78.56, -0.27],
      ],
      bbox: { minLat: -0.28, maxLat: -0.27, minLng: -78.56, maxLng: -78.55 },
      active: true,
    };

    it("solicita ubicación si el prospecto no la provee inicialmente", async () => {
      const repo = new FakeCoverageRepo([chillogalloZone]);
      const coverageService = new CoverageService(repo, new KmlParserService());
      await coverageService.init();

      const workflow = createSalesWorkflow(undefined, coverageService);
      const engine = new WorkflowEngine([workflow]);
      const gateway = new N8nGatewayFake({});

      const ctx: CaseContext = {
        workflowType: "SALES",
        data: { purpose: "sales" },
      };

      const outcome = await engine.step(
        "SALES",
        baseInput("COLLECT_PREFERENCE", ctx, gateway, "Hola quiero contratar internet"),
      );

      expect(outcome).toMatchObject({
        type: "WAITING_USER",
        nextState: "WAITING_USER_LOCATION",
      });
    });

    it("valida cobertura positiva por coordenadas GPS y escala a ventas", async () => {
      const repo = new FakeCoverageRepo([chillogalloZone]);
      const coverageService = new CoverageService(repo, new KmlParserService());
      await coverageService.init();

      const workflow = createSalesWorkflow(undefined, coverageService);
      const engine = new WorkflowEngine([workflow]);
      const gateway = new N8nGatewayFake({
        QUERY_KNOWLEDGE_BASE: () => ({
          success: true,
          result: { found: true, answer: "Plan 300 Mbps $20", planId: "p300", price: 20 },
        }),
      });

      const ctx: CaseContext = {
        workflowType: "SALES",
        data: { purpose: "sales" },
      };

      // 1. Prospecto envía coordenadas en Chillogallo
      let outcome = await engine.step(
        "SALES",
        {
          ...baseInput("COLLECT_PREFERENCE", ctx, gateway, "Vivo en -0.275, -78.555 quiero internet"),
          entities: { lat: -0.275, lng: -78.555 },
        },
      );

      expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "QUERY_PLANS" });
      if (outcome.type !== "CONTINUE") throw new Error("unreachable");
      const salesData = outcome.context.data as SalesContext;
      expect(salesData.coverage?.hasCoverage).toBe(true);
      expect(salesData.coverage?.zoneName).toBe("CHILLOGALLO");

      // 2. Consulta oferta de planes
      outcome = await engine.step(
        "SALES",
        baseInput("QUERY_PLANS", outcome.context, gateway),
      );
      expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "RESPOND_OFFER" });
      if (outcome.type !== "CONTINUE") throw new Error("unreachable");

      // 3. Responde oferta y escala directamente a ventas humanas con cobertura confirmada
      outcome = await engine.step(
        "SALES",
        baseInput("RESPOND_OFFER", outcome.context, gateway),
      );
      expect(outcome.type).toBe("ESCALATED");
      expect((outcome as any).reason).toContain("CHILLOGALLO");
    });

    it("completa el caso con NO_COVERAGE si el punto cae fuera de los polígonos", async () => {
      const repo = new FakeCoverageRepo([chillogalloZone]);
      const coverageService = new CoverageService(repo, new KmlParserService());
      await coverageService.init();

      const workflow = createSalesWorkflow(undefined, coverageService);
      const engine = new WorkflowEngine([workflow]);
      const gateway = new N8nGatewayFake({});

      const ctx: CaseContext = {
        workflowType: "SALES",
        data: { purpose: "sales" },
      };

      // Coordenadas fuera de Chillogallo (ej. Guayaquil)
      const outcome = await engine.step(
        "SALES",
        {
          ...baseInput("COLLECT_PREFERENCE", ctx, gateway, "Ubicación: -2.18, -79.88"),
          entities: { lat: -2.18, lng: -79.88 },
        },
      );

      expect(outcome).toMatchObject({
        type: "COMPLETED",
        nextState: "NO_COVERAGE",
      });
      if (outcome.type !== "COMPLETED") throw new Error("unreachable");
      const salesData = outcome.context.data as SalesContext;
      expect(salesData.coverage?.hasCoverage).toBe(false);
    });

    it("opera bajo el identificador de workflow SALES de punta a punta con ubicación de WhatsApp", async () => {
      const repo = new FakeCoverageRepo([chillogalloZone]);
      const coverageService = new CoverageService(repo, new KmlParserService());
      await coverageService.init();

      const workflow = createSalesWorkflow(undefined, coverageService, "SALES");
      expect(workflow.workflowType).toBe("SALES");

      const engine = new WorkflowEngine([workflow]);
      const gateway = new N8nGatewayFake({
        QUERY_KNOWLEDGE_BASE: () => ({
          success: true,
          result: { found: true, answer: "Fibra 300 Mbps $20", planId: "p300", price: 20 },
        }),
      });

      const ctx: CaseContext = {
        workflowType: "SALES",
        data: { purpose: "sales" },
      };

      // Simula el texto generado por la ingesta de WhatsApp: "Ubicación GPS: -0.2781, -78.5581"
      let outcome = await engine.step(
        "SALES",
        baseInput("COLLECT_PREFERENCE", ctx, gateway, "Ubicación GPS: -0.2781, -78.5581"),
      );

      expect(outcome.type).toBe("CONTINUE");
      expect(outcome.context.workflowType).toBe("SALES");
      expect((outcome.context.data as SalesContext).coverage?.hasCoverage).toBe(true);
      expect((outcome.context.data as SalesContext).coverage?.zoneName).toBe("CHILLOGALLO");

      outcome = await engine.step("SALES", baseInput("QUERY_PLANS", outcome.context, gateway));
      outcome = await engine.step("SALES", baseInput("RESPOND_OFFER", outcome.context, gateway));
      expect(outcome.type).toBe("ESCALATED");
      expect((outcome as any).reason).toContain("CHILLOGALLO");
    });
  });
});
