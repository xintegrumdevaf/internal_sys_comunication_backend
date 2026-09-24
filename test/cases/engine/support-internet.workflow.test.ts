import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../../../src/core/modules/cases/application/engine/workflow-engine";
import { supportInternetWorkflow, normalizeDiagnosticResult } from "../../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
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
  it("normalizeDiagnosticResult mapea MikroTik waiting_user + instruction → WAITING_USER/question", () => {
    const normalized = normalizeDiagnosticResult({
      success: true,
      diagnostic: {
        status: "CRITICAL",
        findings: [{ type: "onu_offline", severity: "high", stopExecution: true }],
        actions: [{ priority: 1, type: "ask_led_status", stopExecution: true }],
      },
      workflow: { status: "waiting_user", currentStep: "ask_led_status", stopExecution: true },
      instruction:
        "Para continuar con la revisión, verifique su equipo de Internet. Si no tiene luces encendidas...",
      technical: { brand: "v-sol" },
    });

    expect(normalized).toEqual({
      status: "WAITING_USER",
      question:
        "Para continuar con la revisión, verifique su equipo de Internet. Si no tiene luces encendidas...",
      diagnostic: "onu_offline",
      technical: { brand: "v-sol" },
    });
  });

  it("normalizeDiagnosticResult aplana la telemetria real de la ONU (potencia, MAC, modelo, estado)", () => {
    const normalized = normalizeDiagnosticResult({
      status: "ESCALATED",
      diagnostic: "onu_offline",
      technical: {
        brand: "v-sol",
        onu: { id: 12, serial: "D011A66CB67C", model: "V2802R" },
        state: { runState: "down", adminState: "enable", channel: "1" },
        power: -29.4,
        mac: { mac: "AA:BB:CC:DD:EE:FF", ontId: 3, vlan: 100, type: "dynamic" },
      },
    });

    expect(normalized.technical).toEqual({
      brand: "v-sol",
      onuModel: "V2802R",
      onuSerial: "D011A66CB67C",
      macAddress: "AA:BB:CC:DD:EE:FF",
      opticalPowerDbm: -29.4,
      runState: "down",
      adminState: "enable",
      channel: "1",
      onuId: 12,
    });
  });

  it("normalizeDiagnosticResult no agrega 'technical' si no hay nada util que leer", () => {
    const normalized = normalizeDiagnosticResult({
      status: "ESCALATED",
      diagnostic: "onu_not_found",
      technical: { onu: null, state: null, mac: null },
    });

    expect(normalized.technical).toBeUndefined();
  });

  it("DIAGNOSTIC con result MikroTik (instruction) entra a WAITING_USER_DIAGNOSTIC con la pregunta", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const instruction =
      "Para continuar con la revisión, verifique su equipo de Internet e indique el color de las luces.";
    const gateway = new N8nGatewayFake({
      DIAGNOSTIC: () => ({
        success: true,
        result: {
          success: true,
          diagnostic: {
            status: "CRITICAL",
            findings: [{ type: "onu_offline" }],
          },
          workflow: { status: "waiting_user", currentStep: "ask_led_status" },
          instruction,
          technical: { brand: "v-sol", power: -25.1 },
        },
      }),
    });

    const withContract: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1", fullName: "Ana" },
        contract: {
          id: "1",
          sector: "pifo",
          oltName: "pifo",
          pon: "1",
          serial: "DF30E67B6ADD",
        },
      },
    };

    const outcome = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("DIAGNOSTIC", withContract, gateway),
    );
    expect(outcome).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_DIAGNOSTIC" });
    if (outcome.type !== "WAITING_USER") throw new Error("unreachable");
    if (outcome.context.workflowType !== "SUPPORT_INTERNET") throw new Error("unreachable");
    expect(outcome.context.data.diagnostic?.lastQuestion).toBe(instruction);
    expect(outcome.context.data.diagnostic?.technical).toEqual({ brand: "v-sol", opticalPowerDbm: -25.1 });
  });

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

  it("cliente validado avanza a CHECK_CLIENT_STATUS, y si está ACTIVO salta directamente a DIAGNOSTIC", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: true,
          contractNumbers: 1,
          contracts: [
            {
              id: "123",
              name: "Juan",
              router: { sector: "pomasqui", olt_name: "olt1", pon: "3", serial: "S1", ip: "10.100.14.6" },
            },
          ],
        },
      }),
      CHECK_CLIENT_STATUS: () => ({
        success: true,
        result: {
          sector: "pomasqui",
          ip: "10.100.14.6",
          status: "ACTIVO",
          list: "ACTIVO",
        },
      }),
    });

    const step1 = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("VALIDATE_CLIENT", contextWithNationalId("123"), gateway),
    );
    expect(step1.type).toBe("CONTINUE");
    if (step1.type !== "CONTINUE") throw new Error("unreachable");
    expect(step1.nextState).toBe("CHECK_CLIENT_STATUS");
    if (step1.context.workflowType !== "SUPPORT_INTERNET") throw new Error("unreachable");
    expect(step1.context.data.contract?.oltName).toBe("olt1");
    expect(step1.context.data.contract?.ip).toBe("10.100.14.6");

    const step2 = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("CHECK_CLIENT_STATUS", step1.context, gateway),
    );
    expect(step2).toMatchObject({ type: "CONTINUE", nextState: "DIAGNOSTIC" });
  });

  it("cliente con status CORTADO avanza a CHECK_BALANCE para consultar deuda", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      CHECK_CLIENT_STATUS: () => ({
        success: true,
        result: {
          sector: "totoracocha",
          ip: "10.100.14.6",
          status: "CORTADO",
          list: "CORTADO",
          reason: "El cliente se encuentra Cortado",
        },
      }),
      CHECK_BALANCE: () => ({ success: true, result: { hasDebt: true, debt: 35.5 } }),
    });

    const withContract: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "123", fullName: "Juan" },
        contract: { id: "123", sector: "totoracocha", oltName: "olt1", pon: "3", serial: "S1", ip: "10.100.14.6" },
      },
    };

    const step1 = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("CHECK_CLIENT_STATUS", withContract, gateway),
    );
    expect(step1).toMatchObject({ type: "CONTINUE", nextState: "CHECK_BALANCE" });
    if (step1.type !== "CONTINUE") throw new Error("unreachable");

    const step2 = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("CHECK_BALANCE", step1.context, gateway),
    );
    expect(step2).toMatchObject({ type: "CONTINUE", nextState: "RESPOND_DEBT" });
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

    const withContract: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1", fullName: "Ana" },
        contract: {
          id: "1",
          sector: "pifo",
          oltName: "pifo",
          pon: "1",
          serial: "DF30E67B6ADD",
        },
      },
    };

    const step1 = await engine.step("SUPPORT_INTERNET", baseInput("DIAGNOSTIC", withContract, gateway));
    expect(step1).toMatchObject({ type: "WAITING_USER", nextState: "WAITING_USER_DIAGNOSTIC" });
    if (step1.type !== "WAITING_USER") throw new Error("unreachable");

    // Contrato API→n8n: camelCase (oltName), no snake_case (olt_name).
    const diagnosticCall = gateway.calls.find((c) => c.action === "DIAGNOSTIC");
    expect(diagnosticCall?.input).toMatchObject({
      sector: "pifo",
      oltName: "pifo",
      pon: "1",
      serial: "DF30E67B6ADD",
    });
    expect(diagnosticCall?.input).not.toHaveProperty("olt_name");

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
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS" });
    if (outcome.type !== "CONTINUE" || outcome.context.workflowType !== "SUPPORT_INTERNET") {
      throw new Error("unreachable");
    }
    expect(outcome.context.data.contract?.oltName).toBe("olt1");
  });

  it("WAITING_USER_DISAMBIGUATE selecciona contrato por selectedOption numerico", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({});
    const context: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1723456789", fullName: "Juan Perez" },
        pendingContracts: [
          {
            id: "CNT-1",
            contractCode: "101",
            name: "Juan Perez",
            address: "Av. Amazonas - Piso 1",
            sector: "pomasqui",
            oltName: "olt1",
            pon: "1",
            serial: "S1",
          },
          {
            id: "CNT-2",
            contractCode: "102",
            name: "Juan Perez",
            address: "Av. Amazonas - Piso 2",
            sector: "pomasqui",
            oltName: "olt2",
            pon: "2",
            serial: "S2",
          },
        ],
      },
    };

    const outcome = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("WAITING_USER_DISAMBIGUATE", context, gateway),
      entities: { selectedOption: 2 },
    });
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS" });
    if (outcome.type !== "CONTINUE" || outcome.context.workflowType !== "SUPPORT_INTERNET") {
      throw new Error("unreachable");
    }
    expect(outcome.context.data.contract?.id).toBe("CNT-2");
    expect(outcome.context.data.contract?.oltName).toBe("olt2");
  });

  it("WAITING_USER_DISAMBIGUATE selecciona contrato por texto plano '2' o 'el primero'", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({});
    const context: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1723456789", fullName: "Juan Perez" },
        pendingContracts: [
          {
            id: "CNT-1",
            name: "Juan Perez",
            address: "Piso 1",
            sector: "pomasqui",
            oltName: "olt1",
            pon: "1",
            serial: "S1",
          },
          {
            id: "CNT-2",
            name: "Juan Perez",
            address: "Piso 2",
            sector: "pomasqui",
            oltName: "olt2",
            pon: "2",
            serial: "S2",
          },
        ],
      },
    };

    const outcomeText2 = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("WAITING_USER_DISAMBIGUATE", context, gateway),
      text: "2",
    });
    expect(outcomeText2).toMatchObject({ type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS" });
    if (outcomeText2.type === "CONTINUE" && outcomeText2.context.workflowType === "SUPPORT_INTERNET") {
      expect(outcomeText2.context.data.contract?.id).toBe("CNT-2");
    }

    const outcomeTextPrimero = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("WAITING_USER_DISAMBIGUATE", context, gateway),
      text: "el primero",
    });
    expect(outcomeTextPrimero).toMatchObject({ type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS" });
    if (outcomeTextPrimero.type === "CONTINUE" && outcomeTextPrimero.context.workflowType === "SUPPORT_INTERNET") {
      expect(outcomeTextPrimero.context.data.contract?.id).toBe("CNT-1");
    }
  });

  it("WAITING_USER_DISAMBIGUATE selecciona contrato por contractCode exacto", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({});
    const context: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1723456789", fullName: "Juan Perez" },
        pendingContracts: [
          {
            id: "1723456789-1",
            contractCode: "COD-9988",
            name: "Juan Perez",
            address: "Casa",
            sector: "pomasqui",
            oltName: "olt1",
            pon: "1",
            serial: "S1",
          },
          {
            id: "1723456789-2",
            contractCode: "COD-7766",
            name: "Juan Perez",
            address: "Oficina",
            sector: "calacali",
            oltName: "olt2",
            pon: "2",
            serial: "S2",
          },
        ],
      },
    };

    const outcome = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("WAITING_USER_DISAMBIGUATE", context, gateway),
      entities: { contractCode: "COD-7766" },
    });
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS" });
    if (outcome.type !== "CONTINUE" || outcome.context.workflowType !== "SUPPORT_INTERNET") {
      throw new Error("unreachable");
    }
    expect(outcome.context.data.contract?.id).toBe("1723456789-2");
    expect(outcome.context.data.contract?.sector).toBe("calacali");
  });

  it("VALIDATE_CLIENT autocompleta con 0 si la cédula viene con 9 dígitos", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    let calledId = "";
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: (params) => {
        calledId = String(params.input.id);
        return {
          success: true,
          result: {
            found: true,
            contracts: [
              {
                id: "1",
                name: "Juan",
                router: { sector: "bellavista", olt_name: "cData", pon: "1", serial: "S1" },
              },
            ],
          },
        };
      },
    });

    const outcome = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("VALIDATE_CLIENT", emptyContext, gateway),
      entities: { nationalId: "942783440" },
    });

    expect(calledId).toBe("0942783440");
    expect(outcome).toMatchObject({ type: "CONTINUE", nextState: "CHECK_CLIENT_STATUS" });
  });

  it("VALIDATE_CLIENT no escala a humano si no encuentra al cliente; queda en WAITING_USER_CLIENT", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => ({
        success: true,
        result: {
          found: false,
          contractNumbers: 0,
          contracts: [],
        },
      }),
    });

    const outcome = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("VALIDATE_CLIENT", emptyContext, gateway),
      entities: { nationalId: "0999999999" },
    });

    expect(outcome).toMatchObject({
      type: "WAITING_USER",
      nextState: "WAITING_USER_CLIENT",
    });
    if (outcome.type !== "WAITING_USER" || outcome.context.workflowType !== "SUPPORT_INTERNET") {
      throw new Error("unreachable");
    }
    expect(outcome.context.data.clientNotFound).toBe(true);
    expect(outcome.context.data.lastSearchedNationalId).toBe("0999999999");
  });

  it("CONTINUE_DIAGNOSTIC con fallo dispara automáticamente fallback a DIAGNOSTIC inicial", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      CONTINUE_DIAGNOSTIC: () => ({
        success: false,
        error: { type: "EXTERNAL_SERVICE_ERROR", message: "session expired", retryable: true },
      }),
      DIAGNOSTIC: (params) => ({
        success: true,
        result: {
          status: "COMPLETED",
          diagnostic: "ONU_REESTABLECIDA_OK",
        },
      }),
    });

    const contextWithContract: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1724482722", fullName: "Jean Pierre" },
        contract: {
          id: "1",
          sector: "pifo",
          oltName: "olt-pifo",
          pon: "1",
          serial: "DF30E67B6ADD",
        },
        diagnostic: {
          status: "PENDING",
          lastQuestion: "¿De qué color son las luces?",
          rounds: 1,
        },
      },
    };

    const outcome = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("WAITING_USER_DIAGNOSTIC", contextWithContract, gateway),
      text: "Son verdes",
      entities: { answer: "Son verdes" },
    });

    // Se intentó CONTINUE_DIAGNOSTIC y falló, por lo que disparó DIAGNOSTIC como fallback
    expect(gateway.actionsCalledFor("CONTINUE_DIAGNOSTIC")).toBe(1);
    expect(gateway.actionsCalledFor("DIAGNOSTIC")).toBe(1);
    const diagCall = gateway.calls.find((c) => c.action === "DIAGNOSTIC");
    expect(diagCall?.input).toMatchObject({
      sector: "pifo",
      oltName: "olt-pifo",
      pon: "1",
      serial: "DF30E67B6ADD",
      message: "Son verdes",
    });
    expect(outcome.type).toBe("COMPLETED");
  });

  it("si CONTINUE_DIAGNOSTIC falla y el fallback DIAGNOSTIC también falla, escala de inmediato a humano sin bucle", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      CONTINUE_DIAGNOSTIC: () => ({
        success: false,
        error: { type: "EXTERNAL_SERVICE_ERROR", message: "session lost", retryable: true },
      }),
      DIAGNOSTIC: () => ({
        success: false,
        error: { type: "EXTERNAL_SERVICE_ERROR", message: "olt timeout", retryable: true },
      }),
    });

    const contextWithContract: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1724482722", fullName: "Jean Pierre" },
        contract: {
          id: "1",
          sector: "pifo",
          oltName: "olt-pifo",
          pon: "1",
          serial: "DF30E67B6ADD",
        },
        diagnostic: {
          status: "PENDING",
          lastQuestion: "¿De qué color son las luces?",
          rounds: 1,
        },
      },
    };

    const outcome = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("WAITING_USER_DIAGNOSTIC", contextWithContract, gateway),
      text: "Son verdes",
      entities: { answer: "Son verdes" },
    });

    expect(gateway.actionsCalledFor("CONTINUE_DIAGNOSTIC")).toBe(1);
    expect(gateway.actionsCalledFor("DIAGNOSTIC")).toBe(1);
    // Escala inmediatamente, nunca vuelve a WAITING_USER_DIAGNOSTIC
    expect(outcome.type).toBe("ESCALATED");
  });

  it("si el servicio de diagnóstico devuelve pregunta repetida sobre las luces, escala a humano para evitar bucle", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      CONTINUE_DIAGNOSTIC: () => ({
        success: true,
        result: {
          status: "WAITING_USER",
          question: "Por favor confirme si las luces del router están encendidas y dígame su color",
        },
      }),
    });

    const contextWithContract: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1724482722", fullName: "Jean Pierre" },
        contract: {
          id: "1",
          sector: "pifo",
          oltName: "olt-pifo",
          pon: "1",
          serial: "DF30E67B6ADD",
        },
        diagnostic: {
          status: "PENDING",
          lastQuestion: "Por favor confirma si las luces de tu router están encendidas y dime de qué color son",
          rounds: 1,
        },
      },
    };

    const outcome = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("WAITING_USER_DIAGNOSTIC", contextWithContract, gateway),
      text: "Son verdes",
      entities: { answer: "Son verdes" },
    });

    expect(outcome.type).toBe("ESCALATED");
    expect((outcome as { reason?: string }).reason).toMatch(/repitió la misma pregunta/i);
  });

  it("si el diagnóstico excede 2 rondas de preguntas, escala a humano", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      CONTINUE_DIAGNOSTIC: () => ({
        success: true,
        result: {
          status: "WAITING_USER",
          question: "¿El cable azul está firmemente conectado?",
        },
      }),
    });

    const contextWithContract: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1724482722", fullName: "Jean Pierre" },
        contract: {
          id: "1",
          sector: "pifo",
          oltName: "olt-pifo",
          pon: "1",
          serial: "DF30E67B6ADD",
        },
        diagnostic: {
          status: "PENDING",
          lastQuestion: "¿Ya reinició el router desconectándolo de la toma eléctrica?",
          rounds: 2, // Ya lleva 2 rondas
        },
      },
    };

    const outcome = await engine.step("SUPPORT_INTERNET", {
      ...baseInput("WAITING_USER_DIAGNOSTIC", contextWithContract, gateway),
      text: "Ya lo reinicié",
      entities: { answer: "Ya lo reinicié" },
    });

    // 2 + 1 = 3 rondas > 2 -> ESCALATED
    expect(outcome.type).toBe("ESCALATED");
    expect((outcome as { reason?: string }).reason).toMatch(/límite de preguntas/i);
  });

  it("VALIDATE_CLIENT no vuelve a consultar n8n ni pedir cédula si los datos ya están en el contexto", async () => {
    const engine = new WorkflowEngine([supportInternetWorkflow]);
    const gateway = new N8nGatewayFake({
      VALIDATE_CLIENT: () => {
        throw new Error("VALIDATE_CLIENT no debería ser llamado si el cliente ya existe");
      },
    });

    const contextWithExistingContract: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1724482722", fullName: "Jean Pierre" },
        contract: {
          id: "1",
          sector: "pifo",
          oltName: "olt-pifo",
          pon: "1",
          serial: "DF30E67B6ADD",
        },
      },
    };

    const outcome = await engine.step(
      "SUPPORT_INTERNET",
      baseInput("VALIDATE_CLIENT", contextWithExistingContract, gateway),
    );

    expect(gateway.actionsCalledFor("VALIDATE_CLIENT")).toBe(0);
    expect(outcome).toMatchObject({
      type: "CONTINUE",
      nextState: "CHECK_CLIENT_STATUS",
    });
  });
});

