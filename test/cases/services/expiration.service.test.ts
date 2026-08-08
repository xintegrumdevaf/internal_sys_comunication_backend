import { describe, expect, it } from "vitest";
import { ExpirationService } from "../../../src/core/modules/cases/application/services/expiration.service";
import { CaseRepositoryFake } from "../fakes";

describe("ExpirationService (docs/spec/02_STATE_MACHINE.md §8)", () => {
  it("mueve a EXPIRED un caso automatizable cuya expires_at ya paso", async () => {
    const caseRepo = new CaseRepositoryFake();
    const { case: created } = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() - 1000), // ya vencido
    });
    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "WAITING_USER",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: created.expiresAt,
    });

    const service = new ExpirationService(caseRepo);
    const expired = await service.expireDueCases();

    expect(expired).toHaveLength(1);
    expect(expired[0]!.status).toBe("EXPIRED");
    const stored = await caseRepo.findById(created.id);
    expect(stored?.case.status).toBe("EXPIRED");
  });

  it("no toca casos sin expires_at o que aun no vencen", async () => {
    const caseRepo = new CaseRepositoryFake();
    await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.create({
      conversationId: "conv-2",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const service = new ExpirationService(caseRepo);
    const expired = await service.expireDueCases();

    expect(expired).toHaveLength(0);
  });

  it("un caso EXPIRED no bloquea crear uno nuevo del mismo workflow_type en la misma conversacion", async () => {
    const caseRepo = new CaseRepositoryFake();
    const { case: created } = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() - 1000),
    });
    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "PAUSED",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: created.expiresAt,
    });
    const service = new ExpirationService(caseRepo);
    await service.expireDueCases();

    const secondCase = await caseRepo.create({
      conversationId: "conv-1",
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(secondCase.case.status).toBe("NEW");
    const all = await caseRepo.listByConversation("conv-1");
    expect(all).toHaveLength(2);
  });
});
