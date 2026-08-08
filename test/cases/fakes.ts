import { randomUUID } from "node:crypto";
import { DomainError } from "../../src/shared/errors/domain-errors";
import { TERMINAL_CASE_STATUSES, type Case } from "../../src/core/modules/cases/domain/case.entity";
import type { WorkflowInstance } from "../../src/core/modules/cases/domain/workflow-instance.entity";
import type { AutomationState } from "../../src/core/modules/cases/domain/automation-state.entity";
import type {
  ApplyCaseTransitionInput,
  CaseAggregate,
  CaseRepositoryPort,
  CreateCaseInput,
} from "../../src/core/modules/cases/application/ports/case.repository.port";
import type {
  ExecuteActionParams,
  N8nActionResult,
  N8nGatewayPort,
} from "../../src/core/modules/cases/application/ports/n8n-gateway.port";
import type { WorkflowExecution } from "../../src/core/modules/cases/domain/workflow-execution.entity";
import type {
  FinishExecutionInput,
  StartExecutionInput,
  WorkflowExecutionRepositoryPort,
} from "../../src/core/modules/cases/application/ports/workflow-execution.repository.port";
import type { N8nWorkflowCategory, N8nWorkflowRegistryEntry } from "../../src/core/modules/cases/domain/n8n-workflow-registry-entry.entity";
import type {
  N8nWorkflowRegistryRepositoryPort,
  UpsertN8nWorkflowRegistryInput,
} from "../../src/core/modules/cases/application/ports/n8n-workflow-registry.repository.port";

/**
 * Fakes en memoria de los ports de `cases` (docs/skills/testing-strategy.md).
 * `CaseRepositoryFake` respeta la concurrencia optimista (version) igual que
 * la implementacion Postgres real, para que los tests de motor/arbitraje no
 * dependan de Postgres/Redis.
 */
export class CaseRepositoryFake implements CaseRepositoryPort {
  readonly cases = new Map<string, Case>();
  readonly workflowInstances = new Map<string, WorkflowInstance>();
  readonly automationStates = new Map<string, AutomationState>();
  readonly events: { caseId: string; type: string; payload: Record<string, unknown> }[] = [];

  async create(input: CreateCaseInput): Promise<CaseAggregate> {
    const now = new Date();
    const caseId = randomUUID();
    const caseEntity: Case = {
      id: caseId,
      conversationId: input.conversationId,
      departmentId: input.departmentId,
      assignedAgentId: null,
      workflowType: input.workflowType,
      status: "NEW",
      context: input.context,
      version: 1,
      lastActivityAt: now,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    const workflowInstance: WorkflowInstance = {
      id: randomUUID(),
      caseId,
      workflowType: input.workflowType,
      currentState: input.initialState,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.cases.set(caseId, caseEntity);
    this.workflowInstances.set(caseId, workflowInstance);
    this.automationStates.set(caseId, {
      caseId,
      enabled: true,
      disabledReason: null,
      changedAt: now,
      changedBy: null,
    });
    return { case: caseEntity, workflowInstance };
  }

  async findById(caseId: string): Promise<CaseAggregate | null> {
    const caseEntity = this.cases.get(caseId);
    const workflowInstance = this.workflowInstances.get(caseId);
    if (!caseEntity || !workflowInstance) {
      return null;
    }
    return { case: caseEntity, workflowInstance };
  }

  async findActiveByConversation(conversationId: string): Promise<CaseAggregate | null> {
    for (const caseEntity of this.cases.values()) {
      if (
        caseEntity.conversationId === conversationId &&
        (caseEntity.status === "ACTIVE" || caseEntity.status === "WAITING_USER")
      ) {
        return { case: caseEntity, workflowInstance: this.workflowInstances.get(caseEntity.id)! };
      }
    }
    return null;
  }

  async findPausedByConversationAndType(
    conversationId: string,
    workflowType: string,
  ): Promise<CaseAggregate | null> {
    for (const caseEntity of this.cases.values()) {
      if (
        caseEntity.conversationId === conversationId &&
        caseEntity.workflowType === workflowType &&
        caseEntity.status === "PAUSED"
      ) {
        return { case: caseEntity, workflowInstance: this.workflowInstances.get(caseEntity.id)! };
      }
    }
    return null;
  }

  async listByConversation(conversationId: string): Promise<Case[]> {
    return [...this.cases.values()].filter((c) => c.conversationId === conversationId);
  }

  async listAutomatableExpiring(now: Date): Promise<Case[]> {
    return [...this.cases.values()].filter(
      (c) => !TERMINAL_CASE_STATUSES.includes(c.status) && c.expiresAt !== null && c.expiresAt.getTime() <= now.getTime(),
    );
  }

  async applyTransition(input: ApplyCaseTransitionInput): Promise<CaseAggregate> {
    const caseEntity = this.cases.get(input.caseId);
    const workflowInstance = this.workflowInstances.get(input.caseId);
    if (!caseEntity || !workflowInstance) {
      throw new Error(`Caso fake ${input.caseId} no encontrado`);
    }
    if (caseEntity.version !== input.expectedCaseVersion || workflowInstance.version !== input.expectedWorkflowVersion) {
      throw new DomainError("BUSINESS_ERROR", `Conflicto de version en caso fake ${input.caseId}`, {
        retryable: true,
      });
    }

    const updatedCase: Case = {
      ...caseEntity,
      status: input.status,
      context: input.context,
      departmentId: input.departmentId ?? caseEntity.departmentId,
      expiresAt: input.expiresAt,
      version: caseEntity.version + 1,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    };
    const updatedInstance: WorkflowInstance = {
      ...workflowInstance,
      currentState: input.currentState,
      version: workflowInstance.version + 1,
      updatedAt: new Date(),
    };
    this.cases.set(caseEntity.id, updatedCase);
    this.workflowInstances.set(caseEntity.id, updatedInstance);
    return { case: updatedCase, workflowInstance: updatedInstance };
  }

  async setAssignedAgent(caseId: string, agentId: string | null): Promise<void> {
    const caseEntity = this.cases.get(caseId);
    if (caseEntity) {
      this.cases.set(caseId, { ...caseEntity, assignedAgentId: agentId });
    }
  }

  async getAutomationState(caseId: string): Promise<AutomationState | null> {
    return this.automationStates.get(caseId) ?? null;
  }

  async setAutomationEnabled(
    caseId: string,
    enabled: boolean,
    options: { reason?: string | null; changedBy?: string | null },
  ): Promise<AutomationState> {
    const state: AutomationState = {
      caseId,
      enabled,
      disabledReason: options.reason ?? null,
      changedAt: new Date(),
      changedBy: options.changedBy ?? null,
    };
    this.automationStates.set(caseId, state);
    return state;
  }

  async appendEvent(caseId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    this.events.push({ caseId, type, payload });
  }

  async listEvents(
    caseId: string,
  ): Promise<Array<{ type: string; payload: Record<string, unknown>; occurredAt: Date }>> {
    return this.events
      .filter((e) => e.caseId === caseId)
      .map((e) => ({ type: e.type, payload: e.payload, occurredAt: new Date() }));
  }
}

export class WorkflowExecutionRepositoryFake implements WorkflowExecutionRepositoryPort {
  readonly executions = new Map<string, WorkflowExecution>();
  startedCallCount = 0;

  async start(input: StartExecutionInput): Promise<WorkflowExecution> {
    const existing = this.executions.get(input.idempotencyKey);
    if (existing) {
      return existing;
    }
    this.startedCallCount += 1;
    const execution: WorkflowExecution = {
      id: randomUUID(),
      workflowInstanceId: input.workflowInstanceId,
      caseId: input.caseId,
      action: input.action,
      status: "DISPATCHED",
      input: input.input,
      output: null,
      error: null,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      startedAt: new Date(),
      completedAt: null,
    };
    this.executions.set(input.idempotencyKey, execution);
    return execution;
  }

  async complete(input: FinishExecutionInput): Promise<WorkflowExecution> {
    const existing = this.executions.get(input.idempotencyKey);
    if (!existing) {
      throw new Error(`workflow_execution fake no encontrada para ${input.idempotencyKey}`);
    }
    const updated: WorkflowExecution = {
      ...existing,
      status: "COMPLETED",
      output: input.output ?? {},
      error: null,
      completedAt: new Date(),
    };
    this.executions.set(input.idempotencyKey, updated);
    return updated;
  }

  async fail(input: FinishExecutionInput): Promise<WorkflowExecution> {
    const existing = this.executions.get(input.idempotencyKey);
    if (!existing) {
      throw new Error(`workflow_execution fake no encontrada para ${input.idempotencyKey}`);
    }
    const updated: WorkflowExecution = {
      ...existing,
      status: "FAILED",
      error: input.error ?? null,
      output: null,
      completedAt: new Date(),
    };
    this.executions.set(input.idempotencyKey, updated);
    return updated;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WorkflowExecution | null> {
    return this.executions.get(idempotencyKey) ?? null;
  }

  async listByCase(caseId: string): Promise<WorkflowExecution[]> {
    return [...this.executions.values()].filter((execution) => execution.caseId === caseId);
  }
}

export type N8nActionHandler = (params: ExecuteActionParams) => N8nActionResult;

/** `N8nGatewayFake` (docs/skills/testing-strategy.md) — responde como respondería n8n real, con un handler por accion. */
export class N8nGatewayFake implements N8nGatewayPort {
  readonly calls: ExecuteActionParams[] = [];

  constructor(private readonly handlers: Record<string, N8nActionHandler>) {}

  async executeAction(params: ExecuteActionParams): Promise<N8nActionResult> {
    this.calls.push(params);
    const handler = this.handlers[params.action];
    if (!handler) {
      return {
        success: false,
        error: { type: "UNSUPPORTED", message: `Sin handler fake para la accion '${params.action}'`, retryable: false },
      };
    }
    return handler(params);
  }

  actionsCalledFor(action: string): number {
    return this.calls.filter((call) => call.action === action).length;
  }
}

/** Fake en memoria de `N8nWorkflowRegistryRepositoryPort` (docs/skills/testing-strategy.md). */
export class N8nWorkflowRegistryRepositoryFake implements N8nWorkflowRegistryRepositoryPort {
  readonly entries = new Map<string, N8nWorkflowRegistryEntry>();
  findByActionCallCount = 0;

  seed(entry: Partial<N8nWorkflowRegistryEntry> & { action: string; url: string }): N8nWorkflowRegistryEntry {
    const full: N8nWorkflowRegistryEntry = {
      category: entry.category ?? "case_action",
      description: entry.description ?? null,
      timeoutMs: entry.timeoutMs ?? 8000,
      maxRetries: entry.maxRetries ?? 2,
      active: entry.active ?? true,
      updatedAt: entry.updatedAt ?? new Date(),
      updatedBy: entry.updatedBy ?? null,
      ...entry,
    };
    this.entries.set(full.action, full);
    return full;
  }

  async findByAction(action: string): Promise<N8nWorkflowRegistryEntry | null> {
    this.findByActionCallCount += 1;
    return this.entries.get(action) ?? null;
  }

  async list(filter?: { category?: N8nWorkflowCategory }): Promise<N8nWorkflowRegistryEntry[]> {
    const all = [...this.entries.values()];
    return filter?.category ? all.filter((entry) => entry.category === filter.category) : all;
  }

  async upsert(input: UpsertN8nWorkflowRegistryInput): Promise<N8nWorkflowRegistryEntry> {
    const entry: N8nWorkflowRegistryEntry = { ...input, updatedAt: new Date() };
    this.entries.set(entry.action, entry);
    return entry;
  }
}
