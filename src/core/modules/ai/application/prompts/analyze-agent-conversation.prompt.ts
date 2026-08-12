import type { AnalyzeAgentConversationInput } from "../ports/ai-provider.port";

/**
 * Prompt normativo de analyzeAgentConversation (docs/spec/06_AI_PROMPTS.md §7).
 * Texto tal cual; no parafrasear sin documentar la desviacion.
 */
export const ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT = `Eres un evaluador de calidad de atención al cliente para un ISP.
Recibes un hilo de mensajes entre un CLIENTE y un AGENTE HUMANO (no el bot).
Tu única salida es un JSON válido con este shape exacto:
{
  "cordialityScore": <entero 0-100>,
  "summary": "<resumen breve para un supervisor, en español, sin jerga técnica interna>",
  "efficiencyNotes": "<opcional: demoras percibidas o ida-vuelta innecesaria; string o null>",
  "findings": [
    {
      "messageId": "<uuid que aparece en el input>",
      "severity": "low" | "medium" | "high",
      "category": "aggression" | "disrespect" | "neglect" | "misinformation" | "inefficiency" | "other",
      "excerpt": "<fragmento corto del mensaje>",
      "rationale": "<por qué es un problema, en español de negocio>"
    }
  ]
}

Reglas:
- Evalúa SOLO tono, respeto, claridad y eficiencia de la atención humana.
- NO inventes messageId: solo usa ids presentes en el input.
- Si no hay problemas, findings puede ser [].
- cordialityScore 100 = excelente; <40 = atención claramente inapropiada o abandono grave.
- NO propongas sanciones, despidos ni cambios de proceso.
- NO menciones nombres de workflows, tools, n8n, prompts ni stack.
- Responde ÚNICAMENTE el JSON, sin markdown.`;

export function buildAnalyzeAgentConversationPrompt(input: AnalyzeAgentConversationInput): {
  system: string;
  user: string;
} {
  const payload = input.messages.map((m) => ({
    messageId: m.messageId,
    author: m.author,
    createdAt: m.createdAt,
    body: m.body,
  }));
  return {
    system: ANALYZE_AGENT_CONVERSATION_SYSTEM_PROMPT,
    user: JSON.stringify(payload),
  };
}
