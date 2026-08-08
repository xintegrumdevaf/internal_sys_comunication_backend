import type { Agent } from "../../domain/agent.entity";

export type CreateAgentInput = {
  name: string;
  email: string;
  isGlobalAdmin?: boolean;
  primaryDepartmentId?: string | null;
};

export interface AgentRepositoryPort {
  list(): Promise<Agent[]>;
  findById(id: string): Promise<Agent | null>;
  create(input: CreateAgentInput): Promise<Agent>;
  addMembership(agentId: string, departmentId: string): Promise<void>;
  belongsToDepartment(agentId: string, departmentId: string): Promise<boolean>;
}
