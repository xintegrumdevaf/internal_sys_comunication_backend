import { describe, expect, it } from "vitest";
import { CancelCaseUseCase } from "../../../src/core/modules/cases/application/use-cases/cancel-case.use-case";
import { CaseRepositoryFake } from "../fakes";
import { ConversationRepositoryFake } from "../../support/fakes";
import { silentLogger } from "../../support/silent-logger";

describe("CancelCaseUseCase (docs/spec/02_STATE_MACHINE.md §2)", () => {
  it("cancela un caso ACTIVE y libera el active_case_id de la conversacion", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const conversation = conversationRepo.createOpen();
    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "ACTIVE",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await conversationRepo.setActiveCaseId(conversation.id, created.id);

    const useCase = new CancelCaseUseCase({ caseRepo, conversationRepo, logger: silentLogger });
    const result = await useCase.execute({ caseId: created.id, reason: "Cliente ya no necesita el servicio" });

    expect(result.status).toBe("CANCELLED");
    const conversationAfter = await conversationRepo.findById(conversation.id);
    expect(conversationAfter?.activeCaseId).toBeNull();
    expect(caseRepo.events).toContainEqual(
      expect.objectContaining({ caseId: created.id, type: "CASE_CANCELLED" }),
    );
  });

  it("rechaza cancelar un caso ya terminal", async () => {
    const caseRepo = new CaseRepositoryFake();
    const conversationRepo = new ConversationRepositoryFake();
    const conversation = conversationRepo.createOpen();
    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: 1,
      status: "COMPLETED",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const useCase = new CancelCaseUseCase({ caseRepo, conversationRepo, logger: silentLogger });
    await expect(useCase.execute({ caseId: created.id, reason: "x" })).rejects.toMatchObject({
      type: "BUSINESS_ERROR",
    });
  });
});
