import type { Agent } from "../domain/agent.entity";

/** DTO publico de un agente — nunca incluye `passwordHash` (ver agent.entity.ts). */
export type AgentDto = Omit<Agent, "passwordHash">;

/**
 * Unico punto por el que un `Agent` sale hacia HTTP. Cualquier router que
 * devuelva un agente (list/create/update/deactivate/login/me) DEBE pasar por
 * aqui — evita que un hash termine filtrado en una respuesta por descuido.
 */
export function toPublicAgentDto(agent: Agent): AgentDto {
  const { passwordHash: _passwordHash, ...publicAgent } = agent;
  return publicAgent;
}

export function toPublicAgentDtoList(agents: Agent[]): AgentDto[] {
  return agents.map(toPublicAgentDto);
}
