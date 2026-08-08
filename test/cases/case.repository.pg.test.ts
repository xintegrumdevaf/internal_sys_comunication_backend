import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { env } from "../../src/shared/config/env";
import { CaseRepositoryPg } from "../../src/core/modules/cases/infrastructure/postgres/case.repository.pg";
import { ConversationRepositoryPg } from "../../src/core/modules/conversations/infrastructure/postgres/conversation.repository.pg";

/**
 * Integracion contra la Postgres real de docker-compose.yml (docs/skills/testing-strategy.md):
 * verifica que el SQL de "case"/workflow_instance/automation_state y la
 * concurrencia optimista (docs/spec/01_DATA_MODEL.md §3) funcionan de verdad.
 */
describe("CaseRepositoryPg", () => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const caseRepo = new CaseRepositoryPg(pool);
  const conversationRepo = new ConversationRepositoryPg(pool);

  afterAll(async () => {
    await pool.end();
  });

  async function seedConversation() {
    return conversationRepo.findOrCreateByWaPhone(`+59399${randomUUID().replace(/-/g, "").slice(0, 7)}`);
  }

  it("crea un Case + WorkflowInstance + AutomationState (habilitada por defecto) en una sola transaccion", async () => {
    const conversation = await seedConversation();

    const { case: created, workflowInstance } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(created.status).toBe("NEW");
    expect(created.departmentId).toBeNull();
    expect(created.assignedAgentId).toBeNull();
    expect(workflowInstance.currentState).toBe("VALIDATE_CLIENT");

    const automation = await caseRepo.getAutomationState(created.id);
    expect(automation?.enabled).toBe(true);

    const found = await caseRepo.findById(created.id);
    expect(found?.case.id).toBe(created.id);
    expect(found?.workflowInstance.id).toBe(workflowInstance.id);
  });

  it("applyTransition actualiza status/context/current_state e incrementa version", async () => {
    const conversation = await seedConversation();
    const { case: created, workflowInstance } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const updated = await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: workflowInstance.version,
      status: "ACTIVE",
      context: { workflowType: "SUPPORT_INTERNET", data: { client: { nationalId: "123", fullName: "Ana" } } },
      currentState: "CHECK_BALANCE",
      expiresAt: null,
    });

    expect(updated.case.status).toBe("ACTIVE");
    expect(updated.case.version).toBe(created.version + 1);
    expect(updated.workflowInstance.currentState).toBe("CHECK_BALANCE");
    expect(updated.workflowInstance.version).toBe(workflowInstance.version + 1);
  });

  it("un conflicto de version optimista (0 filas afectadas) lanza un error retryable", async () => {
    const conversation = await seedConversation();
    const { case: created, workflowInstance } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    await expect(
      caseRepo.applyTransition({
        caseId: created.id,
        expectedCaseVersion: created.version + 999, // version incorrecta a proposito
        expectedWorkflowVersion: workflowInstance.version,
        status: "ACTIVE",
        context: created.context,
        currentState: "CHECK_BALANCE",
        expiresAt: null,
      }),
    ).rejects.toMatchObject({ type: "BUSINESS_ERROR", retryable: true });
  });

  it("findActiveByConversation solo encuentra casos en ACTIVE/WAITING_USER", async () => {
    const conversation = await seedConversation();
    const { case: created, workflowInstance } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    expect(await caseRepo.findActiveByConversation(conversation.id)).toBeNull();

    await caseRepo.applyTransition({
      caseId: created.id,
      expectedCaseVersion: created.version,
      expectedWorkflowVersion: workflowInstance.version,
      status: "ACTIVE",
      context: created.context,
      currentState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const active = await caseRepo.findActiveByConversation(conversation.id);
    expect(active?.case.id).toBe(created.id);
  });

  it("setAutomationEnabled deshabilita la automatizacion con motivo y autor", async () => {
    const conversation = await seedConversation();
    const { case: created } = await caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });

    const state = await caseRepo.setAutomationEnabled(created.id, false, { reason: "Diagnostico no resoluble" });

    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toBe("Diagnostico no resoluble");
    expect(state.changedBy).toBeNull();
  });
});
