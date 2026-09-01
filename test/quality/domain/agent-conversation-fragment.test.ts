import { describe, expect, it } from "vitest";
import { extractAgentConversationFragment } from "../../../src/core/modules/quality/domain/agent-conversation-fragment";
import type { Message } from "../../../src/core/modules/conversations/domain/message.entity";

function makeMessage(
  id: string,
  author: "customer" | "agent" | "bot",
  body: string,
  agentId: string | null = null,
): Message {
  return {
    id,
    conversationId: "conv-1",
    caseId: "case-1",
    direction: author === "customer" ? "inbound" : "outbound",
    author: author as any,
    agentId,
    externalId: id,
    body,
    type: "text",
    mediaId: null,
    mimeType: null,
    caption: null,
    filename: null,
    createdAt: new Date(),
  };
}

describe("extractAgentConversationFragment", () => {
  it("extrae el tramo exacto correspondiente a cada agente en una conversación delegada", () => {
    const agent1 = "agent-111";
    const agent2 = "agent-222";

    const messages: Message[] = [
      makeMessage("m1", "customer", "Hola, no me funciona el internet"),
      makeMessage("m2", "agent", "Hola, soy el agente 1, qué luces tiene su router?", agent1),
      makeMessage("m3", "customer", "La luz de PON está roja"),
      makeMessage("m4", "agent", "Le transfiero con soporte nivel 2", agent1),
      makeMessage("m5", "agent", "Buenas tardes, tomo su caso. Estoy revisando la fibra", agent2),
      makeMessage("m6", "customer", "Gracias, quedo atento"),
      makeMessage("m7", "agent", "Listo, reinicie su equipo por favor", agent2),
      makeMessage("m8", "customer", "Excelente, ya tengo conexión"),
    ];

    // Fragmento para Agente 1
    const fragment1 = extractAgentConversationFragment(messages, agent1);
    expect(fragment1.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);

    // Fragmento para Agente 2
    const fragment2 = extractAgentConversationFragment(messages, agent2);
    expect(fragment2.map((m) => m.id)).toEqual(["m5", "m6", "m7", "m8"]);
  });

  it("devuelve todos los mensajes si ningún mensaje tiene agent_id (compatibilidad legacy)", () => {
    const messages: Message[] = [
      makeMessage("m1", "customer", "Hola"),
      makeMessage("m2", "agent", "Hola, cómo te ayudo?"),
    ];

    const fragment = extractAgentConversationFragment(messages, "any-agent");
    expect(fragment).toHaveLength(2);
  });
});
