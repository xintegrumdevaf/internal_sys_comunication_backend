import { DomainError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AIProviderPort, InterpretMessageInput, Interpretation } from "../ports/ai-provider.port";

/**
 * Interpreta un mensaje vía AIProviderPort (docs/spec/03_API_CONTRACT.md §A.3):
 * timeout/fallo → AI_ERROR; un reintento; si persiste → UNCLEAR.
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
          return { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0 };
        }
      }
    }

    return { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0 };
  }
}
