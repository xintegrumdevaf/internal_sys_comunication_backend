import { describe, expect, it } from "vitest";
import { RefineQuickReplyToneUseCase } from "../../src/core/modules/quick-replies/application/use-cases/refine-quick-reply-tone.use-case";
import { FakeAIProvider } from "../../src/core/modules/ai/infrastructure/fake/fake-ai.provider";
import { DomainError } from "../../src/shared/errors/domain-errors";

describe("RefineQuickReplyToneUseCase", () => {
  it("lanza VALIDATION_ERROR si el texto tiene menos de 5 caracteres", async () => {
    const fakeAi = new FakeAIProvider();
    const useCase = new RefineQuickReplyToneUseCase({ aiProvider: fakeAi });

    await expect(useCase.execute({ text: "hola" })).rejects.toMatchObject({
      type: "VALIDATION_ERROR",
      message: "El texto a refinar debe tener al menos 5 caracteres",
    });

    await expect(useCase.execute({ text: "   " })).rejects.toMatchObject({
      type: "VALIDATION_ERROR",
    });
  });

  it("lanza VALIDATION_ERROR si el texto supera 2000 caracteres", async () => {
    const fakeAi = new FakeAIProvider();
    const useCase = new RefineQuickReplyToneUseCase({ aiProvider: fakeAi });

    const longText = "a".repeat(2001);
    await expect(useCase.execute({ text: longText })).rejects.toMatchObject({
      type: "VALIDATION_ERROR",
      message: "El texto a refinar no puede superar los 2000 caracteres",
    });
  });

  it("llama al AIProviderPort con targetTone y retorna refinedText", async () => {
    const fakeAi = new FakeAIProvider();
    fakeAi.refineTextToneImpl = async (input) => ({
      refinedText: `¡Hola! ${input.text} Muchas gracias.`,
    });

    const useCase = new RefineQuickReplyToneUseCase({ aiProvider: fakeAi });
    const result = await useCase.execute({ text: "pasa tu cedula para ver tu deuda" });

    expect(result.refinedText).toBe("¡Hola! pasa tu cedula para ver tu deuda Muchas gracias.");
  });

  it("propaga el error si el proveedor de IA falla", async () => {
    const fakeAi = new FakeAIProvider();
    fakeAi.refineTextToneImpl = async () => {
      throw new DomainError("AI_ERROR", "Timeout en Ollama", { retryable: true });
    };

    const useCase = new RefineQuickReplyToneUseCase({ aiProvider: fakeAi });
    await expect(useCase.execute({ text: "pasa tu cedula para ver tu deuda" })).rejects.toMatchObject({
      type: "AI_ERROR",
      message: "Timeout en Ollama",
    });
  });
});
