import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AIProviderPort, InterpretMessageInput, Interpretation } from "../ports/ai-provider.port";

/**
 * Interpreta un mensaje (docs/spec/03_API_CONTRACT.md §A.3 + 06_AI_PROMPTS.md §6).
 * Incluye respaldo determinista para un solo campo numerico esperado.
 */
export class InterpretMessageUseCase {
  constructor(
    private readonly provider: AIProviderPort,
    private readonly logger: Logger,
  ) {}

  async execute(input: InterpretMessageInput): Promise<Interpretation> {
    const log = this.logger.child({
      correlationId: input.correlationId,
      conversationId: input.conversationId,
    });

    const deterministic = tryDeterministicSingleNumericField(input);
    if (deterministic) {
      log.info(
        { type: deterministic.type, intent: deterministic.intent, entities: deterministic.entities },
        "interpretacion determinista (campo numerico unico)",
      );
      return deterministic;
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await this.provider.interpretMessage(input);
        log.info(
          { attempt, type: result.type, intent: result.intent, confidence: result.confidence },
          "mensaje interpretado",
        );
        return result;
      } catch (error) {
        const isAiError =
          error instanceof DomainError && (error.type === "AI_ERROR" || error.type === "TIMEOUT");
        log.warn(
          { attempt, err: error instanceof Error ? error.message : String(error), isAiError },
          "fallo al interpretar mensaje",
        );
        if (!isAiError || attempt === 2) {
          log.warn(
            {
              attempt,
              fallback: "UNCLEAR",
              err: error instanceof Error ? error.message : String(error),
            },
            "interpretacion cae a UNCLEAR (el cliente vera mensaje de aclaracion)",
          );
          return { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0 };
        }
      }
    }

    return { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0 };
  }
}

/**
 * 06_AI_PROMPTS.md §6 — si requireAll tiene exactamente un campo y el texto
 * es solo digitos, tratarlo como ANSWER sin LLM.
 */
export function tryDeterministicSingleNumericField(
  input: InterpretMessageInput,
): Interpretation | null {
  const active = input.conversationSnapshot.activeCase;
  const requireAll = active?.requireAll ?? [];
  if (requireAll.length !== 1) return null;
  const field = requireAll[0]!;
  const trimmed = input.text.trim();
  if (!/^\d{5,15}$/.test(trimmed)) return null;

  return {
    type: "ANSWER",
    intent:
      active?.workflowType === "SUPPORT_INTERNET"
        ? "support.internet"
        : active?.workflowType === "BILLING_BALANCE"
          ? "billing.balance"
          : "unknown",
    entities: { [field]: trimmed },
    confidence: 0.99,
  };
}
