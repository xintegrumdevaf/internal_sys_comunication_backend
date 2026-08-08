import type { Agent } from "../../domain/agent.entity";
import type { AgentRepositoryPort } from "../ports/agent.repository.port";

export class ListAgentsUseCase {
  constructor(private readonly agentRepo: AgentRepositoryPort) {}

  async execute(): Promise<Agent[]> {
    return this.agentRepo.list();
  }
}
