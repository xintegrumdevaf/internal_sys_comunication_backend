import { describe, expect, it } from "vitest";
import { CaseArbitrationService } from "../../../src/core/modules/cases/application/services/case-arbitration.service";
import type { Interpretation } from "../../../src/core/modules/cases/application/ports/interpretation.port";
import { CaseRepositoryFake } from "../fakes";
import { silentLogger } from "../../support/silent-logger";

function interpretation(overrides: Partial<Interpretation>): Interpretation {
  return { type: "NEW_INTENT", intent: "support.internet", entities: {}, confidence: 0.9, ...overrides };
}

describe("CaseArbitrationService (docs/spec/02_STATE_MACHINE.md §4)", () => {
  it("sin caso activo, intencion clara y de alta confianza -> ACTIVATE sin nada que pausar", async () => {
    const caseRepo = new CaseRepositoryFake();
    const service = new CaseArbitrationService(caseRepo, silentLogger);

    const decision = await service.decide({
      conversationId: "conv-1",
      interpretation: interpretation({ intent: "support.internet", confidence: 0.9 }),
    });

    expect(decision).toEqual({
      action: "ACTIVATE",
      workflowType: "SUPPORT_INTERNET",
      resumeCaseId: null,
      pauseCaseId: null,
    });
  });

  it("UNCLEAR siempre resulta en CLARIFY, incluso con un caso activo", async () => {
    const caseRepo = new CaseRepositoryFake();
    const service = new CaseArbitrationService(caseRepo, silentLogger);
    await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const decision = await service.decide({
      conversationId: "conv-1",
      interpretation: interpretation({ type: "UNCLEAR", confidence: 0.1 }),
    });

    expect(decision).toEqual({ action: "CLARIFY" });
  });

  it("CONTINUE/ANSWER/CONFIRM sobre un caso activo nunca crea uno nuevo", async () => {
    const caseRepo = new CaseRepositoryFake();
    const { case: active } = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: active.id,
      expectedCaseVersion: active.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: active.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    const service = new CaseArbitrationService(caseRepo, silentLogger);

    const decision = await service.decide({
      conversationId: "conv-1",
      interpretation: interpretation({ type: "ANSWER", intent: "support.internet", confidence: 0.4 }),
    });

    expect(decision).toEqual({ action: "CONTINUE_ACTIVE", caseId: active.id });
  });

  it("cambio de tema con alta confianza pausa el caso activo y activa uno nuevo del otro tipo", async () => {
    const caseRepo = new CaseRepositoryFake();
    const { case: active } = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: active.id,
      expectedCaseVersion: active.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: active.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    const service = new CaseArbitrationService(caseRepo, silentLogger);

    const decision = await service.decide({
      conversationId: "conv-1",
      interpretation: interpretation({ type: "CHANGE_TOPIC", intent: "billing.balance", confidence: 0.85 }),
    });

    expect(decision).toEqual({
      action: "ACTIVATE",
      workflowType: "BILLING_BALANCE",
      resumeCaseId: null,
      pauseCaseId: active.id,
    });
  });

  it("baja confianza con caso activo continua ese caso (02_STATE_MACHINE §7)", async () => {
    const caseRepo = new CaseRepositoryFake();
    const { case: active } = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: active.id,
      expectedCaseVersion: active.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: active.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    const service = new CaseArbitrationService(caseRepo, silentLogger);

    // billing.* exige 0.8; 0.7 no alcanza → no pausa, CONTINUA el caso activo.
    const decision = await service.decide({
      conversationId: "conv-1",
      interpretation: interpretation({ type: "NEW_INTENT", intent: "billing.balance", confidence: 0.7 }),
    });

    expect(decision).toEqual({ action: "CONTINUE_ACTIVE", caseId: active.id });
  });

  it("REQUEST_HUMAN escala directo con el caseId activo si existe", async () => {
    const caseRepo = new CaseRepositoryFake();
    const { case: active } = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: active.id,
      expectedCaseVersion: active.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: active.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    const service = new CaseArbitrationService(caseRepo, silentLogger);

    const decision = await service.decide({
      conversationId: "conv-1",
      interpretation: interpretation({ type: "REQUEST_HUMAN", intent: "unknown", confidence: 0.95 }),
    });

    expect(decision).toEqual({ action: "REQUEST_HUMAN", caseId: active.id });
  });

  it("reanuda un caso PAUSED no expirado del workflow_type destino en vez de crear uno nuevo", async () => {
    const caseRepo = new CaseRepositoryFake();
    const { case: pausedBilling } = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "BILLING_BALANCE",
      departmentId: null,
      context: { workflowType: "BILLING_BALANCE", data: {} },
      initialState: "SOME_STATE",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await caseRepo.applyTransition({
      caseId: pausedBilling.id,
      expectedCaseVersion: pausedBilling.version,
      expectedWorkflowVersion: 1,
      status: "PAUSED",
      context: pausedBilling.context,
      currentState: "SOME_STATE",
      expiresAt: pausedBilling.expiresAt,
    });

    const { case: active } = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: active.id,
      expectedCaseVersion: active.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: active.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const service = new CaseArbitrationService(caseRepo, silentLogger);
    const decision = await service.decide({
      conversationId: "conv-1",
      interpretation: interpretation({ type: "CHANGE_TOPIC", intent: "billing.balance", confidence: 0.9 }),
    });

    expect(decision).toEqual({
      action: "ACTIVATE",
      workflowType: "BILLING_BALANCE",
      resumeCaseId: pausedBilling.id,
      pauseCaseId: active.id,
    });
  });
});
