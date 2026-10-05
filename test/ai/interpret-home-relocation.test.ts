import { describe, expect, it } from "vitest";
import { buildInterpretMessagePrompt } from "../../src/core/modules/ai/application/prompts/interpret-message.prompt";

describe("buildInterpretMessagePrompt - HOME_RELOCATION", () => {
  it("incluye support.home_relocation en los intents del prompt aunque haya dynamicIntents cargados de BD", () => {
    const dynamicIntents = [
      { intent: "support.internet", description: "Soporte técnico" },
      { intent: "billing.balance", description: "Facturación" },
    ];

    const result = buildInterpretMessagePrompt(
      {
        correlationId: "corr-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        text: "voy a cambiarme de domicilio, como puedo hacer con el servicio",
        conversationSnapshot: {
          recentMessages: [],
        },
      },
      dynamicIntents,
    );

    expect(result.system).toContain("support.home_relocation");
    expect(result.system).toContain("TRASLADO O CAMBIO DE DOMICILIO");
    expect(result.system).toContain("voy a cambiarme de domicilio");
  });
});
