import { randomUUID } from "node:crypto";
import type { Agent, AgentRole } from "../../src/core/modules/departments/domain/agent.entity";
import type {
  AgentRepositoryPort,
  CreateAgentInput,
  UpdateAgentPatch,
} from "../../src/core/modules/departments/application/ports/agent.repository.port";
import type { AuditRepositoryPort, RecordAuditEventInput } from "../../src/core/modules/audit/application/ports/audit.repository.port";
import type { AuditEvent } from "../../src/core/modules/audit/domain/audit-event.entity";

export class AgentRepositoryFake implements AgentRepositoryPort {
  readonly agents = new Map<string, Agent>();
  readonly memberships = new Set<string>();

  seed(partial: Partial<Agent> & { name: string; email: string; role?: AgentRole }): Agent {
    const agent: Agent = {
      id: partial.id ?? randomUUID(),
      name: partial.name,
      email: partial.email,
      role: partial.role ?? "agent",
      primaryDepartmentId: partial.primaryDepartmentId ?? null,
      active: partial.active ?? true,
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
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata ?? {},
      actorId: input.actorId ?? null,
      occurredAt: new Date(),
    });
  }

  async list(limit: number): Promise<AuditEvent[]> {
    return this.events.slice(0, limit);
  }
}
