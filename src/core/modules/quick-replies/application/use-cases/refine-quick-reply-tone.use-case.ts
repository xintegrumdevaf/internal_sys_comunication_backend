import type { AIProviderPort } from "../../../ai/application/ports/ai-provider.port";
import { validationError } from "../../../../../shared/errors/domain-errors";

export interface RefineQuickReplyToneDeps {
  aiProvider: AIProviderPort;
}

export interface RefineQuickReplyToneInput {
  text: string;
}

export interface RefineQuickReplyToneOutput {
  refinedText: string;
}

export class RefineQuickReplyToneUseCase {
  constructor(private readonly deps: RefineQuickReplyToneDeps) {}

  async execute(input: RefineQuickReplyToneInput): Promise<RefineQuickReplyToneOutput> {
    const rawText = input.text?.trim();
    if (!rawText || rawText.length < 5) {
      throw validationError("El texto a refinar debe tener al menos 5 caracteres");
    }

    if (rawText.length > 2000) {
      throw validationError("El texto a refinar no puede superar los 2000 caracteres");
    }

    const result = await this.deps.aiProvider.refineTextTone({
      text: rawText,
      targetTone: "empathetic_customer_service",
    });

    return {
      refinedText: result.refinedText,
    };
  }
}
