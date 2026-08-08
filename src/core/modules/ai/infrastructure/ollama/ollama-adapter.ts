import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type {
  AIProviderPort,
  ComposeReplyInput,
  InterpretMessageInput,
  Interpretation,
  InterpretationType,
  ReceiptData,
} from "../../application/ports/ai-provider.port";

export type OllamaAdapterConfig = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
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

/**
 * Adapter Ollama del AIProviderPort (docs/spec/03_API_CONTRACT.md §A).
 */
export class OllamaAdapter implements AIProviderPort {
  constructor(
    private readonly config: OllamaAdapterConfig,
    private readonly logger: Logger,
  ) {}

  async interpretMessage(input: InterpretMessageInput): Promise<Interpretation> {
    const system = `Eres el clasificador de intenciones de un ISP. Responde SOLO JSON valido sin markdown:
{"type":"NEW_INTENT|CONTINUE|ANSWER|CHANGE_TOPIC|CONFIRM|DENY|CANCEL|REQUEST_HUMAN|UNCLEAR","intent":"support.internet|billing.balance|billing.record_payment|sales.packages|unknown","entities":{},"confidence":0.0}
Reglas: no inventes datos tecnicos (sector/olt/pon/serial). Si el usuario pide humano, type=REQUEST_HUMAN. Si no esta claro, UNCLEAR.`;

    const user = JSON.stringify({
      text: input.text,
      activeCase: input.conversationSnapshot.activeCase ?? null,
      correlationId: input.correlationId,
    });

    const raw = await this.chat(system, user);
    return parseInterpretation(raw);
  }

  async composeReply(input: ComposeReplyInput): Promise<string> {
    if (input.templateHint && input.templateHint.trim().length > 0) {
      const system =
        "Reescribe el mensaje de plantilla de forma natural y breve para WhatsApp. Conserva el significado exacto. No agregues datos tecnicos internos ni JSON. Solo el texto final.";
      const raw = await this.chat(system, input.templateHint);
      return raw.trim().replace(/^["']|["']$/g, "");
    }

    const system =
      "Genera un mensaje breve de negocio para WhatsApp a partir del resultado del paso. Nunca devuelvas JSON ni nombres de herramientas.";
    const raw = await this.chat(
      system,
      JSON.stringify({
        workflowType: input.workflowType,
        stepOutcome: input.stepOutcome,
      }),
    );
    return raw.trim();
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

  private async chat(system: string, user: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          format: "json",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        this.logger.warn({ status: response.status, body }, "Ollama rechazo la llamada");
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
        throw new DomainError("TIMEOUT", `Ollama timeout tras ${this.config.timeoutMs}ms`, {
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
