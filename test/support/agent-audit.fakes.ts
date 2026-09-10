import { randomUUID } from "node:crypto";
import type { Agent, AgentRole } from "../../src/core/modules/departments/domain/agent.entity";
import type {
  AgentRepositoryPort,
  CreateAgentInput,
  UpdateAgentPatch,
} from "../../src/core/modules/departments/application/ports/agent.repository.port";
import type {
  AuditRepositoryPort,
  AuditStats,
  AuditStatsFilter,
  ListAuditEventsFilter,
  RecordAuditEventInput,
} from "../../src/core/modules/audit/application/ports/audit.repository.port";
import type { AuditEvent } from "../../src/core/modules/audit/domain/audit-event.entity";

export class AgentRepositoryFake implements AgentRepositoryPort {
  readonly agents = new Map<string, Agent>();
  readonly memberships = new Set<string>();

  seed(partial: Partial<Agent> & { name: string; email: string; role?: AgentRole; departmentIds?: string[] }): Agent {
    const id = partial.id ?? randomUUID();
    const departmentIds = partial.departmentIds ?? [];
    for (const deptId of departmentIds) {
      this.memberships.add(`${id}:${deptId}`);
    }
    const agent: Agent = {
      id,
      name: partial.name,
      email: partial.email,
      role: partial.role ?? "agent",
      primaryDepartmentId: partial.primaryDepartmentId ?? null,
      departmentIds,
      active: partial.active ?? true,
      autoAssignEnabled: partial.autoAssignEnabled ?? false,
      mustChangePassword: partial.mustChangePassword ?? true,
      createdAt: partial.createdAt ?? new Date(),
      passwordHash: partial.passwordHash ?? null,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  async list(): Promise<Agent[]> {
    return [...this.agents.values()];
  }

  async findById(id: string): Promise<Agent | null> {
    return this.agents.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<Agent | null> {
    const needle = email.toLowerCase();
    return [...this.agents.values()].find((a) => a.email.toLowerCase() === needle) ?? null;
  }

  async create(input: CreateAgentInput): Promise<Agent> {
    return this.seed(input);
  }

  async update(id: string, patch: UpdateAgentPatch): Promise<Agent> {
    const current = this.agents.get(id);
    if (!current) throw new Error(`agent ${id} not found`);
    if (patch.departmentIds !== undefined) {
      await this.setMemberships(id, patch.departmentIds);
    }
    const updated: Agent = { ...current, ...patch };
    this.agents.set(id, updated);
    return updated;
  }

  async countActiveAdmins(excludeAgentId?: string): Promise<number> {
    return [...this.agents.values()].filter(
      (a) => a.role === "admin" && a.active && a.id !== excludeAgentId,
    ).length;
  }

  async addMembership(agentId: string, departmentId: string): Promise<void> {
    this.memberships.add(`${agentId}:${departmentId}`);
    const agent = this.agents.get(agentId);
    if (agent && !agent.departmentIds?.includes(departmentId)) {
      agent.departmentIds = [...(agent.departmentIds ?? []), departmentId];
    }
  }

  async setMemberships(agentId: string, departmentIds: string[]): Promise<void> {
    const prefix = `${agentId}:`;
    for (const key of [...this.memberships]) {
      if (key.startsWith(prefix)) this.memberships.delete(key);
    }
    for (const deptId of departmentIds) {
      this.memberships.add(`${agentId}:${deptId}`);
    }
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.departmentIds = [...departmentIds];
    }
  }

  async belongsToDepartment(agentId: string, departmentId: string): Promise<boolean> {
    return this.memberships.has(`${agentId}:${departmentId}`);
  }

  async listMembershipDepartmentIds(agentId: string): Promise<string[]> {
    const prefix = `${agentId}:`;
    return [...this.memberships]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }
}

export class AuditRepositoryFake implements AuditRepositoryPort {
  readonly events: AuditEvent[] = [];

  async record(input: RecordAuditEventInput): Promise<void> {
    this.events.push({
      id: randomUUID(),
      action: input.action,
      category: input.category ?? "operational",
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      actorType: input.actorType ?? "agent",
      actorId: input.actorId ?? null,
      departmentId: input.departmentId ?? null,
      metadata: input.metadata ?? {},
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: input.correlationId ?? null,
      occurredAt: new Date(),
    });
  }

  async list(
    filterOrLimit: number | ListAuditEventsFilter
  ): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
    const limit = typeof filterOrLimit === "number" ? filterOrLimit : (filterOrLimit.limit ?? 50);
    const slice = this.events.slice(0, limit);
    return {
      events: slice,
      nextCursor: null,
    };
  }

  async getStats(_filter?: AuditStatsFilter): Promise<AuditStats> {
    return {
      totalEvents: this.events.length,
      byCategory: {
        security: this.events.filter((e) => e.category === "security").length,
        operational: this.events.filter((e) => e.category === "operational").length,
        data_change: this.events.filter((e) => e.category === "data_change").length,
        system: this.events.filter((e) => e.category === "system").length,
      },
      topActions: [],
      topActors: [],
    };
  }
}
