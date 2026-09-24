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
  RefineTextToneInput,
  RefineTextToneOutput,
} from "../../application/ports/ai-provider.port";
import { buildInterpretMessagePrompt } from "../../application/prompts/interpret-message.prompt";
import { buildComposeReplyPrompt } from "../../application/prompts/compose-reply.prompt";
import { buildAnalyzeAgentConversationPrompt } from "../../application/prompts/analyze-agent-conversation.prompt";
import { buildRefineQuickReplyTonePrompt } from "../../application/prompts/refine-quick-reply-tone.prompt";

export type OllamaAdapterConfig = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Timeout dedicado a analyzeAgentConversation (03 §A.4); default = timeoutMs. */
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

/**
 * Adapter Ollama: solo transporta prompts ya armados (06_AI_PROMPTS.md §1).
 */
export class OllamaAdapter implements AIProviderPort {
  constructor(
    private readonly config: OllamaAdapterConfig,
    private readonly logger: Logger,
    private readonly routingService?: DepartmentRoutingService,
    private readonly promptResolver?: PromptResolverService,
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
      const raw = await this.chat(resolved.system, resolved.user, {
        jsonMode: true,
        temperature: (resolved.modelConfig.temperature as number) ?? 0.2,
      });
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
        "Ollama interpretacion OK",
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
        "Ollama interpretacion FALLO",
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

    const raw = await this.chat(resolved.system, resolved.user, {
      jsonMode: false,
      temperature: (resolved.modelConfig.temperature as number) ?? 0.55,
    });
    return raw.trim().replace(/^["']|["']$/g, "");
  }

  async transcribeAudio(_mediaUrl: string, _mimeType: string): Promise<{ transcript: string }> {
    throw new DomainError("AI_ERROR", "transcribeAudio no disponible en este adapter Ollama", {
      retryable: false,
    });
  }

  async extractReceiptData(_mediaUrl: string, _mimeType: string): Promise<ReceiptData> {
    throw new DomainError("AI_ERROR", "extractReceiptData no disponible en este adapter Ollama", {
      retryable: false,
    });
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
      const raw = await this.chat(system, user, {
        jsonMode: true,
        temperature: 0.15,
          numPredict: 768,
        timeoutMs,
      });
      const analysis = parseQualityAnalysis(raw);
      log.info(
        {
          durationMs: Date.now() - started,
          cordialityScore: analysis.cordialityScore,
          findingsCount: analysis.findings.length,
        },
        "Ollama analisis de calidad OK",
      );
      return analysis;
    } catch (error) {
      log.warn(
        {
          durationMs: Date.now() - started,
          err: error instanceof Error ? error.message : String(error),
          timeoutMs,
        },
        "Ollama analisis de calidad FALLO",
      );
      throw error;
    }
  }

  async refineTextTone(input: RefineTextToneInput): Promise<RefineTextToneOutput> {
    const { system, user } = buildRefineQuickReplyTonePrompt(input);
    const started = Date.now();
    try {
      const raw = await this.chat(system, user, {
        jsonMode: false,
        temperature: 0.3,
        numPredict: 256,
      });
      const refinedText = raw.trim().replace(/^["']|["']$/g, "").trim();
      this.logger.info(
        { durationMs: Date.now() - started, originalLength: input.text.length, refinedLength: refinedText.length },
        "Ollama refineTextTone OK",
      );
      return { refinedText };
    } catch (error) {
      this.logger.warn(
        { durationMs: Date.now() - started, err: error instanceof Error ? error.message : String(error) },
        "Ollama refineTextTone FALLO",
      );
      throw error;
    }
  }

  async chat(
    system: string,
    user: string,
    options?: { jsonMode?: boolean; temperature?: number; numPredict?: number; timeoutMs?: number },
  ): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const payload: Record<string, unknown> = {
        model: this.config.model,
        stream: false,
        think: false,
        keep_alive: "24h",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        options: {
          temperature: options?.temperature ?? 0.2,
          num_predict: options?.numPredict ?? 256,
        },
      };
      if (options?.jsonMode) {
        payload.format = "json";
      }

      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        this.logger.warn({ status: response.status, body: body.slice(0, 300) }, "Ollama rechazo la llamada");
        throw new DomainError("AI_ERROR", `Ollama HTTP ${response.status}`, { retryable: true });
      }

      const data = (await response.json()) as { message?: { content?: string } };
      const content = data.message?.content?.trim();
      if (!content) {
        throw new DomainError("AI_ERROR", "Ollama devolvio respuesta vacia", { retryable: true });
      }
      return content;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new DomainError("TIMEOUT", `Ollama timeout tras ${timeoutMs}ms`, {
          retryable: true,
        });
      }
      throw new DomainError(
        "AI_ERROR",
        error instanceof Error ? error.message : "Error desconocido llamando a Ollama",
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
