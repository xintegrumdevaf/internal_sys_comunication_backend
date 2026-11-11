import type { Logger } from "../../../../../shared/logging/logger";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";
import {
  formatGroundTruthFallbackHtml,
  sanitizeTelegramHtml,
} from "../../application/helpers/telegram-formatting.helper";
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

const DEFAULT_AI_TIMEOUT_MS = 45_000;

export class TelegramAiCopilotAdapter implements TelegramAiCopilotPort {
  constructor(private readonly deps: TelegramAiCopilotAdapterDeps) {}

  async classifyQuestion(question: string): Promise<ExecutiveIntentClassification> {
    const systemPrompt = [
      "Sos el Clasificador de Intenciones del Centinela Operativo de un ISP (Proveedor de Internet).",
      "Tu única tarea es clasificar la consulta de un directivo, gerente o administrador en UNA de estas 5 intenciones:",
      "",
      '- "METRICS_OVERVIEW": TODA pregunta sobre métricas del negocio, áreas o departamentos: ventas, contrataciones, planes, renovaciones, instalaciones, facturación, cobros, soporte técnico, reclamos, volumen de casos (hoy, activos, en cola o recientes), casos resueltos, contención de IA, derivaciones, tiempos de atención o resolución, calidad, FCR, cordialidad o resumen general ("cómo vamos", "cuántas ventas tuvimos", "cómo está facturación").',
      '- "SLA_BREACHES": preguntas específicas sobre clientes esperando sin respuesta, demoras críticas, exceso de tiempo en espera, cuellos de botella o incumplimiento de SLA.',
      '- "AGENTS_STATUS": preguntas específicas sobre asesores, agentes o personal: quiénes están conectados, en turno, disponibles, carga de trabajo por asesor, desempeño individual o cordialidad.',
      '- "INFRA_ALERTS": preguntas sobre red e infraestructura: caídas de fibra, cortes masivos, OLTs, nodos o incidencias en sectores o barrios específicos.',
      '- "OUT_OF_SCOPE": ÚNICAMENTE temas totalmente ajenos al ISP o a la gestión operativa/comercial (ej: chistes, clima, deportes, recetas, preguntas personales, programación general). Ante la duda, si se relaciona con clientes, ventas, plata, soporte, casos, asesores o red, NO es OUT_OF_SCOPE.',
      "",
      "Ejemplos:",
      '- "¿Cuántas ventas tuvimos hoy?" -> {"intent": "METRICS_OVERVIEW", "sector": null, "minWaitMinutes": null, "confidence": 0.98}',
      '- "¿Cómo viene el área de soporte técnico o facturación?" -> {"intent": "METRICS_OVERVIEW", "sector": null, "minWaitMinutes": null, "confidence": 0.97}',
      '- "¿Cuántos casos se resolvieron hoy?" -> {"intent": "METRICS_OVERVIEW", "sector": null, "minWaitMinutes": null, "confidence": 0.98}',
      '- "¿Tenemos clientes esperando más de 20 minutos?" -> {"intent": "SLA_BREACHES", "sector": null, "minWaitMinutes": 20, "confidence": 0.97}',
      '- "¿Quiénes están en turno y atendiendo ahora?" -> {"intent": "AGENTS_STATUS", "sector": null, "minWaitMinutes": null, "confidence": 0.97}',
      '- "¿Hay cortes de fibra en Ricaurte?" -> {"intent": "INFRA_ALERTS", "sector": "Ricaurte", "minWaitMinutes": null, "confidence": 0.97}',
      '- "Contame un chiste" -> {"intent": "OUT_OF_SCOPE", "sector": null, "minWaitMinutes": null, "confidence": 0.99}',
      "",
      "Responde ÚNICAMENTE un objeto JSON estricto con esta estructura:",
      '{"intent": "METRICS_OVERVIEW"|"SLA_BREACHES"|"AGENTS_STATUS"|"INFRA_ALERTS"|"OUT_OF_SCOPE", "sector": string|null, "minWaitMinutes": number|null, "confidence": number}',
    ].join("\n");

    try {
      const responseText = await this.callAi({
        systemPrompt,
        userPrompt: question,
        jsonMode: true,
        numPredict: 140,
      });

      const cleaned = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
      const intent = parsed.intent;
      const validIntents = ["METRICS_OVERVIEW", "SLA_BREACHES", "AGENTS_STATUS", "INFRA_ALERTS", "OUT_OF_SCOPE"];

      if (validIntents.includes(intent)) {
        return {
          intent,
          sector: typeof parsed.sector === "string" && parsed.sector.trim() !== "" ? parsed.sector : undefined,
          minWaitMinutes: typeof parsed.minWaitMinutes === "number" ? parsed.minWaitMinutes : undefined,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.85,
        };
      }
    } catch (err) {
      this.deps.logger.warn({ err, question }, "fallo al clasificar intención con IA; aplicando fallback");
    }

    return this.fallbackClassify(question);
  }

  async synthesizeReply(input: SynthesizeExecutiveReplyInput): Promise<string> {
    if (input.intent === "OUT_OF_SCOPE") {
      return [
        "🤖 <b>Centinela Operativo del ISP</b>",
        "",
        "Hola. Mi función es asistirte exclusivamente en la supervisión operativa y comercial del ISP.",
        "",
        "<i>Podés preguntarme cosas como:</i>",
        '• <i>"¿Cuántas ventas tuvimos hoy?"</i>',
        '• <i>"¿Cómo viene el rendimiento de soporte o facturación?"</i>',
        '• <i>"¿Tenemos clientes esperando más de 20 minutos?"</i>',
        '• <i>"¿Quiénes están en turno y disponibles?"</i>',
        '• <i>"¿Hay cortes o reclamos masivos en Ricaurte?"</i>',
      ].join("\n");
    }

    const systemPrompt = [
      "Sos el Copilot Ejecutivo de un ISP en Telegram.",
      "Un directivo o gerente hizo una consulta operativa o comercial. Te entregamos los datos REALES (Ground Truth) extraídos ahora mismo de la base de datos.",
      "Tu objetivo es responder DIRECTAMENTE lo que preguntó con una síntesis ejecutiva, clara y precisa en HTML para Telegram.",
      "",
      "Reglas ESTRICTAS:",
      "1. Basa tu respuesta ÚNICAMENTE en el Ground Truth. NUNCA inventes cifras, ventas, porcentajes ni nombres.",
      "2. Respondé primero la pregunta puntual (ej. si preguntó por ventas hoy, indicá el dato exacto de ventas/departamento Ventas hoy, luego si existen casos abiertos en curso ahora y tendencia de los últimos 7 días si aporta claridad).",
      "3. Distinguí claramente entre 'hoy (desde 00:00)' y 'en vivo ahora mismo (casos abiertos en curso)'. No confundas casos activos previos con ingresos de hoy.",
      "4. HTML permitido en Telegram ÚNICAMENTE: <b>negrita</b>, <i>cursiva</i>, <code>código</code>. PROHIBIDO usar <br>, <p>, <ul>, <li>, <h1..6> ni Markdown (** o #). Usá saltos de línea reales y viñetas con • o emojis.",
      "5. Longitud ideal: 4 a 8 líneas directas y ejecutivas.",
    ].join("\n");

    const userPrompt = [
      `Pregunta del directivo: "${input.question}"`,
      "",
      "Datos Reales (Ground Truth):",
      input.groundTruth,
    ].join("\n");

    try {
      const response = await this.callAi({
        systemPrompt,
        userPrompt,
        jsonMode: false,
        numPredict: 512,
      });

      const sanitized = sanitizeTelegramHtml(response);
      if (sanitized.length > 0) {
        return sanitized;
      }
    } catch (err) {
      this.deps.logger.warn({ err }, "error al sintetizar respuesta con IA; usando fallback de datos HTML");
    }

    return formatGroundTruthFallbackHtml(input.groundTruth);
  }

  private fallbackClassify(question: string): ExecutiveIntentClassification {
    const lower = question.toLowerCase();
    if (lower.includes("sla") || lower.includes("demora") || lower.includes("espera") || lower.includes("retraso")) {
      return { intent: "SLA_BREACHES", confidence: 0.7 };
    }
    if (lower.includes("asesor") || lower.includes("agente") || lower.includes("personal") || lower.includes("turno")) {
      return { intent: "AGENTS_STATUS", confidence: 0.7 };
    }
    if (
      lower.includes("red") ||
      lower.includes("fibra") ||
      lower.includes("corte") ||
      lower.includes("olt") ||
      lower.includes("caida") ||
      lower.includes("caída")
    ) {
      return { intent: "INFRA_ALERTS", confidence: 0.7 };
    }
    return { intent: "METRICS_OVERVIEW", confidence: 0.6 };
  }

  private async callAi(params: {
    systemPrompt: string;
    userPrompt: string;
    jsonMode: boolean;
    numPredict: number;
  }): Promise<string> {
    const aiSettings = await this.deps.settingsService.getAiSettings();
    const effectiveTimeoutMs =
      this.deps.timeoutMs ?? (aiSettings.aiCallTimeoutMs || DEFAULT_AI_TIMEOUT_MS);

    if (aiSettings.provider === "ollama") {
      return this.callOllama(aiSettings.ollamaBaseUrl, aiSettings.ollamaModel, {
        ...params,
        timeoutMs: effectiveTimeoutMs,
      });
    }

    return this.callGemini(aiSettings.geminiApiKey, aiSettings.geminiModel, {
      ...params,
      timeoutMs: effectiveTimeoutMs,
    });
  }

  private async callGemini(
    apiKey: string,
    model: string,
    params: { systemPrompt: string; userPrompt: string; jsonMode: boolean; timeoutMs: number },
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
      signal: AbortSignal.timeout(params.timeoutMs),
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
    params: {
      systemPrompt: string;
      userPrompt: string;
      jsonMode: boolean;
      numPredict: number;
      timeoutMs: number;
    },
    disableThinkFlag = false,
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
      keep_alive: "24h",
      options: {
        temperature: 0.2,
        num_predict: params.numPredict,
      },
    };

    if (!disableThinkFlag) {
      body.think = false;
    }

    if (params.jsonMode) {
      body.format = "json";
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(params.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (res.status === 400 && !disableThinkFlag && errText.toLowerCase().includes("think")) {
        return this.callOllama(baseUrl, model, params, true);
      }
      throw new Error(`Ollama respondió status ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      message?: { content?: string };
    };

    return data.message?.content || "";
  }
}
