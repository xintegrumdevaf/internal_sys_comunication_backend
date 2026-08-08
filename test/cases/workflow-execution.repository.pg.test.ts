import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { env } from "../../src/shared/config/env";
import { CaseRepositoryPg } from "../../src/core/modules/cases/infrastructure/postgres/case.repository.pg";
import { WorkflowExecutionRepositoryPg } from "../../src/core/modules/cases/infrastructure/postgres/workflow-execution.repository.pg";
import { ConversationRepositoryPg } from "../../src/core/modules/conversations/infrastructure/postgres/conversation.repository.pg";

/**
 * Integracion contra Postgres real: `UNIQUE(idempotency_key)` es un
 * no-negociable de AGENTS.md ("idempotencia obligatoria ... en todo
 * intercambio API<->n8n") y solo se verifica de verdad contra la base.
 */
describe("WorkflowExecutionRepositoryPg", () => {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const caseRepo = new CaseRepositoryPg(pool);
  const executionRepo = new WorkflowExecutionRepositoryPg(pool);
  const conversationRepo = new ConversationRepositoryPg(pool);

  afterAll(async () => {
    await pool.end();
  });

  async function seedCaseAggregate() {
    const conversation = await conversationRepo.findOrCreateByWaPhone(
      `+59399${randomUUID().replace(/-/g, "").slice(0, 7)}`,
    );
    return caseRepo.create({
      conversationId: conversation.id,
      workflowType: "SUPPORT_INTERNET",
      departmentId: null,
      context: { workflowType: "SUPPORT_INTERNET", data: {} },
      initialState: "VALIDATE_CLIENT",
      expiresAt: null,
    });
  }

  it("start es idempotente por UNIQUE(idempotency_key): un reintento no crea una segunda fila", async () => {
    const { case: created, workflowInstance } = await seedCaseAggregate();
    const idempotencyKey = `${created.id}:VALIDATE_CLIENT:abc123`;

    const first = await executionRepo.start({
      workflowInstanceId: workflowInstance.id,
      caseId: created.id,
      action: "VALIDATE_CLIENT",
      input: { nationalId: "1" },
      idempotencyKey,
      correlationId: "corr-1",
    });
    const second = await executionRepo.start({
      workflowInstanceId: workflowInstance.id,
      caseId: created.id,
      action: "VALIDATE_CLIENT",
      input: { nationalId: "1" },
      idempotencyKey,
      correlationId: "corr-1",
    });

    expect(second.id).toBe(first.id);
    const all = await executionRepo.listByCase(created.id);
    expect(all).toHaveLength(1);
  });

  it("complete/fail actualizan el estado de la ejecucion dispatchada", async () => {
    const { case: created, workflowInstance } = await seedCaseAggregate();
    const idempotencyKey = `${created.id}:CHECK_BALANCE:def456`;

    await executionRepo.start({
      workflowInstanceId: workflowInstance.id,
      caseId: created.id,
      action: "CHECK_BALANCE",
      input: {},
      idempotencyKey,
      correlationId: "corr-2",
    });

    const completed = await executionRepo.complete({ idempotencyKey, output: { hasDebt: false } });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.output).toEqual({ hasDebt: false });

    const found = await executionRepo.findByIdempotencyKey(idempotencyKey);
    expect(found?.status).toBe("COMPLETED");
  });

  it("fail deja error estructurado y status FAILED", async () => {
    const { case: created, workflowInstance } = await seedCaseAggregate();
    const idempotencyKey = `${created.id}:DIAGNOSTIC:ghi789`;

    await executionRepo.start({
      workflowInstanceId: workflowInstance.id,
      caseId: created.id,
      action: "DIAGNOSTIC",
      input: {},
      idempotencyKey,
      correlationId: "corr-3",
    });

    const failed = await executionRepo.fail({
      idempotencyKey,
      error: { type: "EXTERNAL_SERVICE_ERROR", message: "MikroTik timeout", retryable: true },
    });

    expect(failed.status).toBe("FAILED");
    expect(failed.error).toEqual({ type: "EXTERNAL_SERVICE_ERROR", message: "MikroTik timeout", retryable: true });
  });
});
