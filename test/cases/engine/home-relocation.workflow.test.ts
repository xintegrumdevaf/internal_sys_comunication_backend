import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { createHomeRelocationWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/home-relocation.workflow";
import type { CaseContext } from "../../../src/core/modules/cases/domain/contexts/case-context";
import { N8nGatewayFake } from "../fakes";
import type { RagService } from "../../../src/core/modules/ai/application/services/rag.service";

const fakeRagService: RagService = {
  query: async (q: string) => {
    if (/costo|cuesta|cuanto|cuánto/i.test(q)) {
      return {
        found: true,
        answer: "El costo del traslado de domicilio es de $15.00 e incluye la visita técnica e instalación en la nueva dirección.",
        sources: ["políticas.pdf"],
        confidenceScore: 0.95,
      };
    }
    return { found: false, confidenceScore: 0 };
  },
} as unknown as RagService;

const emptyContext: CaseContext = {
  workflowType: "HOME_RELOCATION",
  data: {},
};

function baseInput(currentState: string, context: CaseContext, gateway: N8nGatewayFake) {
  return {
    caseId: "case-reloc",
    conversationId: "conv-reloc",
    correlationId: "corr-reloc",
    currentState,
    context,
    gateway,
  };
}

describe("homeRelocationWorkflow", () => {
  it("sin nationalId ni cliente validado pide WAITING_USER_CLIENT sin llamar n8n", async () => {
    const workflow = createHomeRelocationWorkflow(fakeRagService);
    const engine = new WorkflowEngine([workflow]);
    const gateway = new N8nGatewayFake({});

    const outcome = await engine.step(
      "HOME_RELOCATION",
      baseInput("VALIDATE_CLIENT", emptyContext, gateway),
    );
    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_CLIENT" });
    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(0);
  });

  it("con nationalId invalido en n8n pide WAITING_USER_CLIENT y marca clientNotFound", async () => {
    const workflow = createHomeRelocationWorkflow(fakeRagService);
    const engine = new WorkflowEngine([workflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: false,
        error: { type: "NOT_FOUND", message: "Cliente no encontrado", retryable: false },
      }),
    });

    const ctx: CaseContext = {
      workflowType: "HOME_RELOCATION",
      data: { client: { nationalId: "0999999999", fullName: "" } },
    };

    const outcome = await engine.step("HOME_RELOCATION", baseInput("VALIDATE_CLIENT", ctx, gateway));
    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_CLIENT" });
    if (outcome.context.workflowType !== "HOME_RELOCATION") throw new Error("unreachable");
    expect(outcome.context.data.clientNotFound).toBe(true);
  });

  it("con cliente validado exitosamente pasa a GATHER_RELOCATION_DETAILS", async () => {
    const workflow = createHomeRelocationWorkflow(fakeRagService);
    const engine = new WorkflowEngine([workflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [
            {
              id: "ct-100",
              name: "Juan Pérez",
              address: "Av. Shyris",
              router: { sector: "Norte", olt_name: "olt-1", pon: "1", serial: "sn-1" },
            },
          ],
        },
      }),
    });

    const ctx: CaseContext = {
      workflowType: "HOME_RELOCATION",
      data: { client: { nationalId: "1720001112", fullName: "" } },
    };

    const step1 = await engine.step("HOME_RELOCATION", baseInput("VALIDATE_CLIENT", ctx, gateway));
    expect(step1).toMatchObject({ type: "CONTINUE", nextState: "GATHER_RELOCATION_DETAILS" });
    if (step1.type !== "CONTINUE" || step1.context.workflowType !== "HOME_RELOCATION") throw new Error("unreachable");
    expect(step1.context.data.client?.fullName).toBe("Juan Pérez");
  });

  it("pide datos faltantes de traslado en GATHER_RELOCATION_DETAILS si no estan completos", async () => {
    const workflow = createHomeRelocationWorkflow(fakeRagService);
    const engine = new WorkflowEngine([workflow]);
    const gateway = new N8nGatewayFake({});

    const ctx: CaseContext = {
      workflowType: "HOME_RELOCATION",
      data: {
        client: { nationalId: "1720001112", fullName: "Juan Pérez" },
        relocationDetails: { newAddress: "Av. 10 de Agosto y Colón" },
      },
    };

    const step = await engine.step(
      "HOME_RELOCATION",
      {
        ...baseInput("GATHER_RELOCATION_DETAILS", ctx, gateway),
        entities: { references: "Junto al banco Pichincha" },
      },
    );

    expect(step).toMatchObject({ type: "WAITING_USER", nextState: "GATHER_RELOCATION_DETAILS" });
    if (step.context.workflowType !== "HOME_RELOCATION") throw new Error("unreachable");
    expect(step.context.data.relocationDetails?.newAddress).toBe("Av. 10 de Agosto y Colón");
    expect(step.context.data.relocationDetails?.references).toBe("Junto al banco Pichincha");
    expect(step.context.data.relocationDetails?.mapLocation).toBeUndefined();
  });

  it("responde consulta RAG en GATHER_RELOCATION_DETAILS si el cliente hace una pregunta de negocio", async () => {
    const workflow = createHomeRelocationWorkflow(fakeRagService);
    const engine = new WorkflowEngine([workflow]);
    const gateway = new N8nGatewayFake({});

    const ctx: CaseContext = {
      workflowType: "HOME_RELOCATION",
      data: {
        client: { nationalId: "1720001112", fullName: "Juan Pérez" },
      },
    };

    const step = await engine.step(
      "HOME_RELOCATION",
      {
        ...baseInput("GATHER_RELOCATION_DETAILS", ctx, gateway),
        text: "¿Cuánto me cuesta el traslado?",
        entities: { question: "¿Cuánto me cuesta el traslado?" },
      },
    );

    expect(step).toMatchObject({ type: "WAITING_USER", nextState: "GATHER_RELOCATION_DETAILS" });
    if (step.context.workflowType !== "HOME_RELOCATION") throw new Error("unreachable");
    expect(step.context.data.ragAnswer).toContain("El costo del traslado de domicilio es de $15.00");
  });

  it("con todos los datos de traslado completos pasa a CREATE_TICKET_AND_ESCALATE y ESCALATED", async () => {
    const workflow = createHomeRelocationWorkflow(fakeRagService);
    const engine = new WorkflowEngine([workflow]);
    const gateway = new N8nGatewayFake({});

    const ctx: CaseContext = {
      workflowType: "HOME_RELOCATION",
      data: {
        client: { nationalId: "1720001112", fullName: "Juan Pérez" },
        relocationDetails: {
          newAddress: "Calle Los Nogales E4-12 y Av. Eloy Alfaro",
          references: "Frente a la farmacia Fybeca, casa de dos pisos blanca",
          mapLocation: "https://maps.google.com/?q=-0.180653, -78.467838",
        },
      },
    };

    const step1 = await engine.step(
      "HOME_RELOCATION",
      baseInput("GATHER_RELOCATION_DETAILS", ctx, gateway),
    );
    expect(step1).toMatchObject({ type: "CONTINUE", nextState: "CREATE_TICKET_AND_ESCALATE" });
    if (step1.type !== "CONTINUE") throw new Error("unreachable");

    const step2 = await engine.step(
      "HOME_RELOCATION",
      baseInput("CREATE_TICKET_AND_ESCALATE", step1.context, gateway),
    );
    expect(step2.type).toBe("ESCALATED");
    if (step2.type !== "ESCALATED") throw new Error("unreachable");
    expect(step2.reason).toContain("Solicitud de traslado de domicilio completada");
  });

  it("avanza correctamente desde WAITING_USER_CLIENT cuando el cliente responde con su cedula", async () => {
    const workflow = createHomeRelocationWorkflow(fakeRagService);
    const engine = new WorkflowEngine([workflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [
            {
              id: "ct-200",
              name: "Carlos Torres",
              address: "Av. Maldonado",
              router: { sector: "Sur", olt_name: "olt-2", pon: "1", serial: "sn-2" },
            },
          ],
        },
      }),
    });

    const outcome = await engine.step("HOME_RELOCATION", {
      ...baseInput("WAITING_USER_CLIENT", emptyContext, gateway),
      entities: { nationalId: "1704288123" },
      text: "mi cedula es 1704288123",
    });

    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "GATHER_RELOCATION_DETAILS" });
    if (outcome.type !== "CONTINUE" || outcome.context.workflowType !== "HOME_RELOCATION") throw new Error("unreachable");
    expect(outcome.context.data.client?.fullName).toBe("Carlos Torres");
  });
});
