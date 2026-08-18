import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type {
  AIProviderPort,
  AnalyzeAgentConversationInput,
  ComposeReplyInput,
  InterpretMessageInput,
  Interpretation,
  InterpretationType,
  QualityAnalysis,
  ReceiptData,
} from "../../application/ports/ai-provider.port";
import { buildInterpretMessagePrompt } from "../../application/prompts/interpret-message.prompt";
import { buildComposeReplyPrompt } from "../../application/prompts/compose-reply.prompt";
import { buildAnalyzeAgentConversationPrompt } from "../../application/prompts/analyze-agent-conversation.prompt";

export type GeminiAdapterConfig = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  qualityTimeoutMs?: number;
};

const INTERPRETATION_TYPES: ReadonlySet<string> = new Set([
  "NEW_INTENT",
  "CONTINUE",
  "ANSWER",
  "CHANGE_TOPIC",
  "CONFIRM",
  "DENY",
  "CANCEL",
  "REQUEST_HUMAN",
  "UNCLEAR",
]);

export class GeminiAdapter implements AIProviderPort {
  constructor(
    private readonly config: GeminiAdapterConfig,
    private readonly logger: Logger,
  ) {}

  async interpretMessage(input: InterpretMessageInput): Promise<Interpretation> {
    const log = this.logger.child({
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    });
    const { system, user } = buildInterpretMessagePrompt(input);
    const started = Date.now();
    try {
      const payload = this.buildBasePayload(system, user, { jsonMode: true, temperature: 0.2 });
      const raw = await this.callGemini(payload, this.config.timeoutMs);
      const interpretation = parseInterpretation(raw);
      log.info(
        {
          durationMs: Date.now() - started,
          type: interpretation.type,
          intent: interpretation.intent,
          confidence: interpretation.confidence,
          textPreview: input.text.slice(0, 80),
        },
        "Gemini interpretacion OK",
      );
      return interpretation;
    } catch (error) {
      log.warn(
        {
          durationMs: Date.now() - started,
          err: error instanceof Error ? error.message : String(error),
          textPreview: input.text.slice(0, 80),
          timeoutMs: this.config.timeoutMs,
        },
        "Gemini interpretacion FALLO",
      );
      throw error;
    }
  }

  async composeReply(input: ComposeReplyInput): Promise<string> {
    const { system, user } = buildComposeReplyPrompt(input);
    const payload = this.buildBasePayload(system, user, { jsonMode: false, temperature: 0.55 });
    const raw = await this.callGemini(payload, this.config.timeoutMs);
    return raw.trim().replace(/^["']|["']$/g, "");
  }

  async transcribeAudio(mediaUrl: string, mimeType: string): Promise<{ transcript: string }> {
    const started = Date.now();
    try {
      const base64Data = await this.downloadMediaAsBase64(mediaUrl);
      const system = "Sos un transcriptor de audio profesional e inteligente. Transcribí el audio palabra por palabra. Si está en español, mantenelo en español. Si el audio está en otro idioma, transcribilo en ese mismo idioma (no lo traduzcas). Devolvé únicamente la transcripción limpia, sin comentarios ni explicaciones adicionales.";
      const user = "Transcribí este archivo de audio de forma limpia:";
      
      const payload = {
        contents: [
          {
            role: "user",
            parts: [
              { text: user },
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ],
          },
        ],
        systemInstruction: {
          parts: [{ text: system }],
        },
        generationConfig: {
          temperature: 0.1,
        },
      };

      const raw = await this.callGemini(payload, this.config.timeoutMs);
      this.logger.info(
        { durationMs: Date.now() - started, mimeType },
        "Gemini transcripcion de audio OK",
      );
      return { transcript: raw.trim() };
    } catch (error) {
      this.logger.warn(
        { started, err: error instanceof Error ? error.message : String(error) },
        "Gemini transcripcion de audio FALLO",
      );
      throw error;
    }
  }

  async extractReceiptData(mediaUrl: string, mimeType: string): Promise<ReceiptData> {
    const started = Date.now();
    try {
      const base64Data = await this.downloadMediaAsBase64(mediaUrl);
      const system = "Sos un extractor de datos de recibos de pago. Analizá la imagen provista y extraé los siguientes campos en formato JSON:\n- amount: el monto total pagado como un número con decimales (por ejemplo, 12500.50).\n- reference: el número de transacción o referencia como texto.\n- date: la fecha de la transacción en formato YYYY-MM-DD.\n\nDevolvé ÚNICAMENTE el objeto JSON correspondiente. Si no lográs identificar alguno de los campos, dejalo como null.";
      const user = "Extraé los datos del siguiente recibo:";

      const payload = {
        contents: [
          {
            role: "user",
            parts: [
              { text: user },
              {
                inlineData: {
                  mimeType,
                  data: base64Data,
                },
              },
            ],
          },
        ],
        systemInstruction: {
          parts: [{ text: system }],
        },
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      };

      const raw = await this.callGemini(payload, this.config.timeoutMs);
      const data = parseReceiptData(raw);
      this.logger.info(
        { durationMs: Date.now() - started, amount: data.amount, reference: data.reference },
        "Gemini extraccion de recibo OK",
      );
      return data;
    } catch (error) {
      this.logger.warn(
        { started, err: error instanceof Error ? error.message : String(error) },
        "Gemini extraccion de recibo FALLO",
      );
      throw error;
    }
  }

  async analyzeAgentConversation(input: AnalyzeAgentConversationInput): Promise<QualityAnalysis> {
    const log = this.logger.child({
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      caseId: input.caseId,
      agentId: input.agentId,
    });
    const { system, user } = buildAnalyzeAgentConversationPrompt(input);
    const timeoutMs = Math.max(this.config.timeoutMs, this.config.qualityTimeoutMs ?? this.config.timeoutMs);
    const started = Date.now();
    try {
      const payload = this.buildBasePayload(system, user, { jsonMode: true, temperature: 0.15 });
      const raw = await this.callGemini(payload, timeoutMs);
      const analysis = parseQualityAnalysis(raw);
      log.info(
        {
          durationMs: Date.now() - started,
          cordialityScore: analysis.cordialityScore,
          findingsCount: analysis.findings.length,
        },
        "Gemini analisis de calidad OK",
      );
      return analysis;
    } catch (error) {
      log.warn(
        {
          durationMs: Date.now() - started,
          err: error instanceof Error ? error.message : String(error),
          timeoutMs,
        },
        "Gemini analisis de calidad FALLO",
      );
      throw error;
    }
  }

  private buildBasePayload(
    system: string,
    user: string,
    options: { jsonMode: boolean; temperature: number },
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: user,
            },
          ],
        },
      ],
      systemInstruction: {
        parts: [
          {
            text: system,
          },
        ],
      },
      generationConfig: {
        temperature: options.temperature,
      },
    };

    if (options.jsonMode) {
      payload.generationConfig = {
        ...((payload.generationConfig as Record<string, unknown>) || {}),
        responseMimeType: "application/json",
      };
    }
    return payload;
  }

  private async downloadMediaAsBase64(url: string): Promise<string> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer).toString("base64");
    } catch (error) {
      throw new DomainError(
        "AI_ERROR",
        `No se pudo descargar la media para Gemini: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
  }

  private async callGemini(payload: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent?key=${this.config.apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        this.logger.warn({ status: response.status, body: body.slice(0, 300) }, "Gemini rechazo la llamada");
        throw new DomainError("AI_ERROR", `Gemini HTTP ${response.status}`, { retryable: true });
      }

      interface GeminiResponse {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
            }>;
          };
        }>;
      }

      const data = (await response.json()) as GeminiResponse;
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!content) {
        throw new DomainError("AI_ERROR", "Gemini devolvio respuesta vacia", { retryable: true });
      }
      return content;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new DomainError("TIMEOUT", `Gemini timeout tras ${timeoutMs}ms`, {
          retryable: true,
        });
      }
      throw new DomainError(
        "AI_ERROR",
        error instanceof Error ? error.message : "Error desconocido llamando a Gemini",
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseInterpretation(raw: string): Interpretation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new DomainError("AI_ERROR", "Interpretacion no es JSON valido", { retryable: true });
    }
    parsed = JSON.parse(match[0]);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new DomainError("AI_ERROR", "Interpretacion invalida", { retryable: true });
  }

  const obj = parsed as Record<string, unknown>;
  const type = String(obj.type ?? "UNCLEAR");
  if (!INTERPRETATION_TYPES.has(type)) {
    throw new DomainError("AI_ERROR", `type de interpretacion desconocido: ${type}`, {
      retryable: true,
    });
  }

  const confidence = Number(obj.confidence);
  return {
    type: type as InterpretationType,
    intent: typeof obj.intent === "string" ? obj.intent : "unknown",
    entities:
      obj.entities && typeof obj.entities === "object" && !Array.isArray(obj.entities)
        ? (obj.entities as Record<string, unknown>)
        : {},
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

function parseReceiptData(raw: string): ReceiptData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new DomainError("AI_ERROR", "Datos de recibo no es JSON valido", { retryable: true });
    }
    parsed = JSON.parse(match[0]);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new DomainError("AI_ERROR", "Datos de recibo invalidos", { retryable: true });
  }

  const obj = parsed as Record<string, unknown>;
  const amount = obj.amount !== undefined && obj.amount !== null ? Number(obj.amount) : undefined;
  return {
    amount: amount && Number.isFinite(amount) ? amount : undefined,
    reference: typeof obj.reference === "string" || typeof obj.reference === "number" ? String(obj.reference) : undefined,
    date: typeof obj.date === "string" ? obj.date : undefined,
  };
}

function parseQualityAnalysis(raw: string): QualityAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new DomainError("AI_ERROR", "Analisis de calidad no es JSON valido", { retryable: true });
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new DomainError("AI_ERROR", "Analisis de calidad no es JSON valido", { retryable: true });
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("AI_ERROR", "Analisis de calidad invalido", { retryable: true });
  }

  const obj = parsed as Record<string, unknown>;
  const score = Number(obj.cordialityScore);
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new DomainError("AI_ERROR", "cordialityScore invalido en analisis de calidad", {
      retryable: true,
    });
  }
  if (typeof obj.summary !== "string" || obj.summary.trim().length === 0) {
    throw new DomainError("AI_ERROR", "summary invalido en analisis de calidad", { retryable: true });
  }

  const findingsRaw = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: QualityAnalysis["findings"] = [];
  for (const item of findingsRaw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (typeof f.messageId !== "string") continue;
    if (typeof f.severity !== "string" || typeof f.category !== "string") continue;
    if (typeof f.excerpt !== "string" || typeof f.rationale !== "string") continue;
    findings.push({
      messageId: f.messageId,
      severity: f.severity as QualityAnalysis["findings"][number]["severity"],
      category: f.category as QualityAnalysis["findings"][number]["category"],
      excerpt: f.excerpt,
      rationale: f.rationale,
    });
  }

  const efficiencyNotes =
    typeof obj.efficiencyNotes === "string"
      ? obj.efficiencyNotes
      : obj.efficiencyNotes === null
        ? undefined
        : undefined;

  return {
    cordialityScore: score,
    summary: obj.summary,
    efficiencyNotes,
    findings,
  };
}
