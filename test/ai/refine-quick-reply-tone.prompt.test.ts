import { describe, expect, it } from "vitest";
import { buildRefineQuickReplyTonePrompt } from "../../src/core/modules/ai/application/prompts/refine-quick-reply-tone.prompt";

describe("buildRefineQuickReplyTonePrompt", () => {
  it("construye el prompt del sistema con directivas descriptivas y sin sesgos de ejemplos hardcodeados", () => {
    const prompt = buildRefineQuickReplyTonePrompt({
      text: "Tu deuda es {{deuda}}. Paga en {{enlace}}",
    });

    expect(prompt.system).toContain("IDENTIFICACIÓN DE INTENCIÓN Y PROHIBICIÓN DE SALUDOS REDUNDANTES");
    expect(prompt.system).toContain("DESPEDIDA");
    expect(prompt.system).toContain("PROPORCIONALIDAD DE LONGITUD Y BREVEDAD");
    expect(prompt.system).toContain("FIDELIDAD DE ENTIDADES Y VARIABLES");
    expect(prompt.system).toContain("USO CÁLIDO Y MEDIDO DE EMOJIS");
    expect(prompt.system).toContain("XGO");
    expect(prompt.system).not.toContain("Ejemplos:");
    expect(prompt.user).toContain("Tu deuda es {{deuda}}. Paga en {{enlace}}");
  });
});
