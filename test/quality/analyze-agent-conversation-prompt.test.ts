import { describe, expect, it } from "vitest";
import {
  ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT,
  buildAnalyzeAgentConversationPrompt,
} from "../../src/core/modules/ai/application/prompts/analyze-agent-conversation.prompt";

describe("analyzeAgentConversationPrompt", () => {
  it("contiene reglas normativas contra falsos positivos de respeto, ráfagas y demoras", () => {
    // 1. Ráfagas y puntuación continuada
    expect(ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT).toContain("RÁFAGAS DE MENSAJES Y PUNTUACIÓN CONTINUA");
    expect(ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT).toContain("NUNCA califiques un '?' suelto");

    // 2. Separación entre texto cortés y demora SLA
    expect(ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT).toContain("SEPARACIÓN ESTRICTA: TEXTO CORTÉS vs DEMORA TEMPORAL");
    expect(ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT).toContain("inefficiency");

    // 3. Seguimiento ante silencio del cliente vs abandono
    expect(ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT).toContain("SEGUIMIENTO ANTE SILENCIO DEL CLIENTE vs ABANDONO");

    // 4. Lectura de adjuntos multimedia
    expect(ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT).toContain("LECTURA DE ARCHIVOS Y MULTIMEDIA OBLIGATORIA");
  });

  it("construye el prompt del usuario preservando messageId, author, createdAt y body", () => {
    const input = {
      correlationId: "corr-1",
      conversationId: "conv-1",
      caseId: "case-1",
      agentId: "agent-1",
      messages: [
        {
          messageId: "m-1",
          author: "agent" as const,
          createdAt: "2026-11-04T16:19:00.000Z",
          body: "Buenas tardes, cómo continua con su servicio",
        },
        {
          messageId: "m-2",
          author: "agent" as const,
          createdAt: "2026-11-04T16:19:15.000Z",
          body: "?",
        },
      ],
    };

    const prompt = buildAnalyzeAgentConversationPrompt(input);
    expect(prompt.system).toBe(ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT);

    const parsedUser = JSON.parse(prompt.user);
    expect(parsedUser).toHaveLength(2);
    expect(parsedUser[0].body).toBe("Buenas tardes, cómo continua con su servicio");
    expect(parsedUser[1].body).toBe("?");
  });
});
