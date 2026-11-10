import type { Logger } from "../../../../../shared/logging/logger";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";
import type {
  ExecutiveIntentClassification,
  SynthesizeExecutiveReplyInput,
  TelegramAiCopilotPort,
} from "../../application/ports/telegram-ai-copilot.port";

export interface TelegramAiCopilotAdapterDeps {
  settingsService: SystemSettingsService;
  logger: Logger;
  timeoutMs?: number;
}

export class TelegramAiCopilotAdapter implements TelegramAiCopilotPort {
  private readonly timeoutMs: number;

  constructor(private readonly deps: TelegramAiCopilotAdapterDeps) {
    this.timeoutMs = deps.timeoutMs ?? 15_000;
  }

  async classifyQuestion(question: string): Promise<ExecutiveIntentClassification> {
    const systemPrompt = [
      "Sos el Clasificador de Intenciones del Centinela Operativo de un ISP.",
      "Tu tarea es clasificar la consulta de un directivo en una de estas 5 intenciones:",
      '- "METRICS_OVERVIEW": consultas sobre volumen de casos hoy, casos resueltos, contención de IA, tiempos de atención, KPIs generales.',
      '- "SLA_BREACHES": consultas sobre clientes esperando mucho tiempo, casos desatendidos, demoras o cuellos de botella.',
      '- "AGENTS_STATUS": consultas sobre quiénes están conectados, asesores en turno, carga de trabajo o disponibilidad de asignación.',
      '- "INFRA_ALERTS": consultas sobre caídas de fibra, cortes de OLT, problemas en sectores o barrios específicos.',
      '- "OUT_OF_SCOPE": preguntas que no tienen que ver con la operación del ISP (temas personales, chistes, conocimientos generales).',
      "",
      "Responde ÚNICAMENTE un objeto JSON estricto con esta estructura:",
      '{"intent": "METRICS_OVERVIEW"|"SLA_BREACHES"|"AGENTS_STATUS"|"INFRA_ALERTS"|"OUT_OF_SCOPE", "sector": string|null, "minWaitMinutes": number|null, "confidence": number}',
    ].join("\n");

    try {
      const responseText = await this.callAi({
        systemPrompt,
        userPrompt: question,
        jsonMode: true,
      });

      const parsed = JSON.parse(responseText.replace(/```json/g, "").replace(/```/g, "").trim());
      const intent = parsed.intent;
      const validIntents = ["METRICS_OVERVIEW", "SLA_BREACHES", "AGENTS_STATUS", "INFRA_ALERTS", "OUT_OF_SCOPE"];

      if (validIntents.includes(intent)) {
        return {
          intent,
          sector: typeof parsed.sector === "string" ? parsed.sector : undefined,
          minWaitMinutes: typeof parsed.minWaitMinutes === "number" ? parsed.minWaitMinutes : undefined,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
        };
      }
    } catch (err) {
      this.deps.logger.warn({ err, question }, "fallo al clasificar intención con IA; aplicando fallback");
    }

    // Heurística de fallback básica si la IA no estuviera disponible
    const lower = question.toLowerCase();
    if (lower.includes("sla") || lower.includes("demora") || lower.includes("espera") || lower.includes("retraso")) {
      return { intent: "SLA_BREACHES", confidence: 0.7 };
    }
    if (lower.includes("asesor") || lower.includes("agente") || lower.includes("personal") || lower.includes("turno")) {
      return { intent: "AGENTS_STATUS", confidence: 0.7 };
    }
    if (lower.includes("red") || lower.includes("fibra") || lower.includes("corte") || lower.includes("olt") || lower.includes("caida")) {
      return { intent: "INFRA_ALERTS", confidence: 0.7 };
    }
    return { intent: "METRICS_OVERVIEW", confidence: 0.5 };
  }

  async synthesizeReply(input: SynthesizeExecutiveReplyInput): Promise<string> {
    if (input.intent === "OUT_OF_SCOPE") {
      return [
        "🤖 <b>Centinela Operativo del ISP</b>",
        "",
        "Hola. Mi función es asistirte exclusivamente en la supervisión operativa del ISP.",
        "",
        "<i>Podés preguntarme cosas como:</i>",
        "• <i>\"¿Cómo viene el rendimiento de soporte hoy?\"</i>",
        "• <i>\"¿Tenemos clientes esperando más de 20 minutos?\"</i>",
        "• <i>\"¿Quiénes están en turno y disponibles?\"</i>",
        "• <i>\"¿Hay cortes o reclamos masivos en Ricaurte?\"</i>",
      ].join("\n");
    }

    const systemPrompt = [
      "Sos el Copilot Ejecutivo de un ISP en Telegram.",
      "Un director o gerente hizo una consulta operativa. Te entregamos los datos REALES (Ground Truth) del sistema.",
      "Tu objetivo es redactar una síntesis concisa, profesional y de alto nivel en HTML para Telegram.",
      "",
      "Reglas ESTRICTAS:",
      "1. Basa tu respuesta ÚNICAMENTE en el Ground Truth. NUNCA inventes números, porcentajes ni nombres.",
      "2. Formato HTML permitido en Telegram: <b>negrita</b>, <i>cursiva</i>, <code>código</code>, y viñetas con emojis.",
      "3. Longitud máxima: 4 a 6 líneas. Sé directo y ejecutivo.",
      "4. No uses encabezados Markdown (# o ##).",
    ].join("\n");

    const userPrompt = [
      `Pregunta del directivo: "${input.question}"`,
      "",
      `Datos Reales (Ground Truth):`,
      input.groundTruth,
    ].join("\n");

    try {
      const response = await this.callAi({
        systemPrompt,
        userPrompt,
        jsonMode: false,
      });

      if (response && response.trim().length > 0) {
        return response.trim();
      }
    } catch (err) {
      this.deps.logger.warn({ err }, "error al sintetizar respuesta con IA; usando fallback de datos");
    }

    // Fallback limpio mostrando los datos directamente
    return [
      "🤖 <b>Resumen Operativo Solicitado</b>",
      "",
      input.groundTruth,
    ].join("\n");
  }

  private async callAi(params: {
    systemPrompt: string;
    userPrompt: string;
    jsonMode: boolean;
  }): Promise<string> {
    const aiSettings = await this.deps.settingsService.getAiSettings();

    if (aiSettings.provider === "ollama") {
      return this.callOllama(aiSettings.ollamaBaseUrl, aiSettings.ollamaModel, params);
    }

    return this.callGemini(aiSettings.geminiApiKey, aiSettings.geminiModel, params);
  }

  private async callGemini(
    apiKey: string,
    model: string,
    params: { systemPrompt: string; userPrompt: string; jsonMode: boolean },
  ): Promise<string> {
    if (!apiKey || apiKey.trim() === "") {
      throw new Error("Gemini API key no configurada");
    }

    const effectiveModel = model || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${effectiveModel}:generateContent?key=${apiKey.trim()}`;

    const body: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [{ text: params.userPrompt }],
        },
      ],
      systemInstruction: {
        parts: [{ text: params.systemPrompt }],
      },
      generationConfig: {
        temperature: 0.2,
      },
    };

    if (params.jsonMode) {
      (body.generationConfig as Record<string, unknown>).responseMimeType = "application/json";
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini respondió status ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!answer) {
      throw new Error("Respuesta vacía de Gemini");
    }

    return answer;
  }

  private async callOllama(
    baseUrl: string,
    model: string,
    params: { systemPrompt: string; userPrompt: string; jsonMode: boolean },
  ): Promise<string> {
    const host = (baseUrl || "http://localhost:11434").replace(/\/$/, "");
    const effectiveModel = model || "qwen3.5:4b";
    const url = `${host}/api/chat`;

    const body: Record<string, unknown> = {
      model: effectiveModel,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
      stream: false,
      options: {
        temperature: 0.2,
      },
    };

    if (params.jsonMode) {
      body.format = "json";
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Ollama respondió status ${res.status}`);
    }

    const data = (await res.json()) as {
      message?: { content?: string };
    };

    return data.message?.content || "";
  }
}

