import { DomainError } from "../../../../../shared/errors/domain-errors";
import { env } from "../../../../../shared/config/env";
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
  RefineTextToneInput,
  RefineTextToneOutput,
} from "../../application/ports/ai-provider.port";
import { buildInterpretMessagePrompt } from "../../application/prompts/interpret-message.prompt";
import { buildComposeReplyPrompt } from "../../application/prompts/compose-reply.prompt";
import { buildAnalyzeAgentConversationPrompt } from "../../application/prompts/analyze-agent-conversation.prompt";
import { buildRefineQuickReplyTonePrompt } from "../../application/prompts/refine-quick-reply-tone.prompt";

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

import type { DepartmentRoutingService } from "../../../departments/application/services/department-routing.service";
import type { PromptResolverService } from "../../application/services/prompt-resolver.service";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";
import type { MediaStoragePort } from "../../../conversations/application/ports/media-storage.port";

export class GeminiAdapter implements AIProviderPort {
  constructor(
    private readonly config: GeminiAdapterConfig,
    private readonly logger: Logger,
    private readonly routingService?: DepartmentRoutingService,
    private readonly promptResolver?: PromptResolverService,
    private readonly settingsService?: SystemSettingsService,
    private readonly mediaStorage?: MediaStoragePort,
  ) {}

  async interpretMessage(input: InterpretMessageInput): Promise<Interpretation> {
    const log = this.logger.child({
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    });
    const dynamicIntents = this.routingService ? await this.routingService.getPromptIntents() : undefined;
    const fallback = () => buildInterpretMessagePrompt(input, dynamicIntents);
    const resolved = this.promptResolver
      ? await this.promptResolver.resolvePrompt(
          "interpret_message",
          {
            text: input.text,
            recentMessages: input.conversationSnapshot?.recentMessages,
            activeCase: input.conversationSnapshot?.activeCase,
          },
          fallback,
        )
      : { ...fallback(), modelConfig: { temperature: 0.2 }, versionNumber: 0, source: "fallback_code" as const };

    const started = Date.now();
    try {
      const payload = this.buildBasePayload(resolved.system, resolved.user, {
        jsonMode: true,
        temperature: (resolved.modelConfig.temperature as number) ?? 0.2,
      });
      const raw = await this.callGemini(payload, this.config.timeoutMs);
      const interpretation = parseInterpretation(raw);
      log.info(
        {
          durationMs: Date.now() - started,
          type: interpretation.type,
          intent: interpretation.intent,
          confidence: interpretation.confidence,
          textPreview: input.text.slice(0, 80),
          promptSource: resolved.source,
          promptVersion: resolved.versionNumber,
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
    const fallback = () => buildComposeReplyPrompt(input);
    const stepResult =
      input.stepOutcome?.result && typeof input.stepOutcome.result === "object"
        ? (input.stepOutcome.result as Record<string, unknown>)
        : undefined;
    const resolved = this.promptResolver
      ? await this.promptResolver.resolvePrompt(
          "compose_reply",
          {
            clientName: typeof stepResult?.clientName === "string" ? stepResult.clientName : "",
            clientFirstName: typeof stepResult?.clientFirstName === "string" ? stepResult.clientFirstName : "",
            stepOutcome: input.stepOutcome,
            templateHint: input.templateHint,
            missingFields: input.missingFields,
            workflowType: input.workflowType,
          },
          fallback,
        )
      : { ...fallback(), modelConfig: { temperature: 0.55 }, versionNumber: 0, source: "fallback_code" as const };

    const payload = this.buildBasePayload(resolved.system, resolved.user, {
      jsonMode: false,
      temperature: (resolved.modelConfig.temperature as number) ?? 0.55,
    });
    const raw = await this.callGemini(payload, this.config.timeoutMs);
    return raw.trim().replace(/^["']|["']$/g, "");
  }

  async refineTextTone(input: RefineTextToneInput): Promise<RefineTextToneOutput> {
    const { system, user } = buildRefineQuickReplyTonePrompt(input);
    const payload = this.buildBasePayload(system, user, { jsonMode: false, temperature: 0.3 });
    const raw = await this.callGemini(payload, this.config.timeoutMs);
    const refinedText = raw.trim().replace(/^["']|["']$/g, "").trim();
    return { refinedText };
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
      const system = "Sos un analizador y extractor visual de archivos multimedia (imágenes, videos y documentos) para una empresa proveedora de internet (ISP). Tu tarea es determinar con precisión el contenido del archivo adjunto y si corresponde a un comprobante de pago o a otro tema operativo (por ejemplo: video/foto de router o equipos de red, estado de luces del módem, cables de fibra, video/foto de televisor, captura de pantalla de speedtest, contrato, o comprobante de pago bancario).\n\n" +
        "Devolvé un único objeto JSON con los siguientes campos:\n" +
        "- isReceipt: booleano (true únicamente si el archivo muestra claramente un comprobante de pago, transferencia bancaria o depósito; false si muestra equipos, routers, cables, pantallas de TV o cualquier otra cosa operativa).\n" +
        "- amount: el monto numérico del pago si es visible (ej: 25.50), o null si no se identifica.\n" +
        "- reference: el número de comprobante, autorización o transacción como texto, o null si no es visible.\n" +
        "- date: la fecha de la transacción en formato YYYY-MM-DD, o null si no es visible.\n" +
        "- description: una descripción muy concisa (máximo 15 palabras) de lo que muestra el archivo (ej: 'video de router con luz roja LOS parpadeando', 'foto de cables desconectados detrás del módem', 'captura de speedtest con baja velocidad', 'comprobante de depósito bancario').\n\n" +
        "Devolvé ÚNICAMENTE el JSON correspondiente.";
      const user = "Analizá el contenido del siguiente archivo adjunto (imagen, video o documento):";

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
        { durationMs: Date.now() - started, isReceipt: data.isReceipt, amount: data.amount, reference: data.reference },
        "Gemini análisis de imagen y recibo OK",
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

  async chat(
    system: string,
    user: string,
    options?: { jsonMode?: boolean; temperature?: number; timeoutMs?: number },
  ): Promise<string> {
    const payload = this.buildBasePayload(system, user, {
      jsonMode: options?.jsonMode ?? false,
      temperature: options?.temperature ?? 0.2,
    });
    return this.callGemini(payload, options?.timeoutMs ?? this.config.timeoutMs);
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
      if (this.mediaStorage) {
        const stored = await this.mediaStorage.ensureStored(url);
        if (stored) {
          return stored.buffer.toString("base64");
        }
      }

      const headers: Record<string, string> = {};
      let zernioApiKey = env.ZERNIO_API_KEY;
      if (this.settingsService) {
        try {
          const ch = await this.settingsService.getChannelSettings();
          if (ch.zernioApiKey) zernioApiKey = ch.zernioApiKey;
        } catch {
          // fallback
        }
      }
      if (url.includes("zernio") && zernioApiKey) {
        headers["Authorization"] = `Bearer ${zernioApiKey}`;
      }
      let response = await fetch(url, { headers });
      if (!response.ok && Object.keys(headers).length > 0) {
        response = await fetch(url);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (this.mediaStorage) {
        await this.mediaStorage.save(url, buffer, response.headers.get("content-type"));
      }
      return buffer.toString("base64");
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
      let apiKey = this.config.apiKey || env.GEMINI_API_KEY || "";
      let model = this.config.model;

      if (this.settingsService) {
        try {
          const aiSettings = await this.settingsService.getAiSettings();
          if (aiSettings.geminiApiKey) apiKey = aiSettings.geminiApiKey;
          if (aiSettings.geminiModel) model = aiSettings.geminiModel;
        } catch {
          // Fallback a config inicial
        }
      }

      if (!model || model === "gemini-2.5-flash" || model === "gemini-2.5-flash-lite") {
        model = "gemini-3.5-flash";
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
  const isReceipt = obj.isReceipt === true;
  const amount = obj.amount !== undefined && obj.amount !== null ? Number(obj.amount) : undefined;
  const reference = typeof obj.reference === "string" || typeof obj.reference === "number" ? String(obj.reference) : undefined;
  const date = typeof obj.date === "string" ? obj.date : undefined;
  const description = typeof obj.description === "string" ? obj.description : undefined;

  return {
    isReceipt,
    amount: amount && Number.isFinite(amount) ? amount : undefined,
    reference,
    date,
    description,
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
