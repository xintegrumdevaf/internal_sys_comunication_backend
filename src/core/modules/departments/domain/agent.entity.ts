export type AgentRole = "agent" | "manager" | "admin";

export interface Agent {
  id: string;
  name: string;
  email: string;
  role: AgentRole;
  primaryDepartmentId: string | null;
  active: boolean;
  createdAt: Date;
}
