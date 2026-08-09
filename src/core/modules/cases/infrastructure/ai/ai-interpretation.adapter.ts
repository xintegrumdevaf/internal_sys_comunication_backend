import type { Logger } from "../../../../../shared/logging/logger";
import type { AIProviderPort } from "../../../ai/application/ports/ai-provider.port";
import { InterpretMessageUseCase } from "../../../ai/application/use-cases/interpret-message.use-case";
import type {
  Interpretation,
  InterpretationPort,
  InterpretMessageInput as CasesInterpretInput,
} from "../../application/ports/interpretation.port";

/**
 * Puente hexagonal cases → ai (InterpretationPort → AIProviderPort).
 */
export class AiInterpretationAdapter implements InterpretationPort {
  private readonly interpretUseCase: InterpretMessageUseCase;

  constructor(provider: AIProviderPort, logger: Logger) {
    this.interpretUseCase = new InterpretMessageUseCase(provider, logger);
  }

  async interpretMessage(input: CasesInterpretInput & { messageId?: string }): Promise<Interpretation> {
    const result = await this.interpretUseCase.execute({
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      messageId: input.messageId ?? input.correlationId,
      text: input.text,
      conversationSnapshot: {
        activeCase: input.activeCase
          ? {
              workflowType: input.activeCase.workflowType,
              pendingQuestion: input.activeCase.pendingQuestion,
              requireAll: input.activeCase.requireAll,
              requireAny: input.activeCase.requireAny,
            }
          : undefined,
      },
    });

    return {
      type: result.type,
      intent: result.intent,
      entities: result.entities,
      confidence: result.confidence,
    };
  }
}
