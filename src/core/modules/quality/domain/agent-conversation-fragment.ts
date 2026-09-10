import type { Message } from "../../conversations/domain/message.entity";

/**
 * Extrae el fragmento cronológico de mensajes entre el cliente y un agente específico
 * en casos con transferencias / delegaciones multi-agente (07_QUALITY_SUPERVISION.md).
 */
export function extractAgentConversationFragment(
  messages: Message[],
  targetAgentId: string,
): Message[] {
  if (messages.length === 0) return [];

  // Filtrar autores válidos (solo customer y agent)
  const humanMessages = messages.filter(
    (m) => m.author === "customer" || m.author === "agent",
  );

  // Identificar si hay mensajes explícitos con agentId
  const agentMessages = humanMessages.filter(
    (m) => m.author === "agent" && m.agentId === targetAgentId,
  );

  // Si no hay mensajes etiquetados para este agente puntual:
  if (agentMessages.length === 0) {
    // Si ningún mensaje tiene agentId (mensajes legacy), devolvemos todo el hilo
    const anyHasAgentId = humanMessages.some((m) => m.author === "agent" && !!m.agentId);
    if (!anyHasAgentId) {
      return humanMessages;
    }
    return [];
  }

  // Encontrar índices del primer y último mensaje del agente objetivo
  let firstIdx = -1;
  let lastIdx = -1;

  for (let i = 0; i < humanMessages.length; i++) {
    const m = humanMessages[i]!;
    if (m.author === "agent" && m.agentId === targetAgentId) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }

  // Buscar hacia atrás el último mensaje de OTRO agente antes de firstIdx
  let startIdx = 0;
  for (let i = firstIdx - 1; i >= 0; i--) {
    const m = humanMessages[i]!;
    if (m.author === "agent" && m.agentId && m.agentId !== targetAgentId) {
      startIdx = i + 1;
      break;
    }
  }

  // Buscar hacia adelante el primer mensaje de OTRO agente después de lastIdx
  let endIdx = humanMessages.length - 1;
  for (let i = lastIdx + 1; i < humanMessages.length; i++) {
    const m = humanMessages[i]!;
    if (m.author === "agent" && m.agentId && m.agentId !== targetAgentId) {
      endIdx = i - 1;
      break;
    }
  }

  // Extraer el subconjunto y excluir mensajes de otros agentes que pudieran haber quedado en el rango
  const slice = humanMessages.slice(startIdx, endIdx + 1);
  return slice.filter(
    (m) => m.author === "customer" || (m.author === "agent" && m.agentId === targetAgentId) || (m.author === "agent" && !m.agentId),
  );
}
