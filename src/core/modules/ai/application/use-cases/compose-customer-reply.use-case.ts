import type { AIProviderPort, ComposeReplyInput } from "../ports/ai-provider.port";

/**
 * Compone el texto final para el cliente. Si hay `templateHint`, es la fuente
 * de verdad del contenido; el provider solo puede naturalizar (02_STATE_MACHINE §12).
 * Nunca se envía JSON crudo de un paso de n8n.
 */
export class ComposeCustomerReplyUseCase {
  constructor(private readonly provider: AIProviderPort) {}

  async execute(input: ComposeReplyInput): Promise<string> {
    if (input.templateHint && input.templateHint.trim().length > 0) {
      const rendered = renderTemplate(input.templateHint, input.stepOutcome.result ?? {});
      try {
        const naturalized = await this.provider.composeReply({
          ...input,
          templateHint: rendered,
        });
        const text = naturalized.trim();
        if (text.length > 0 && !looksLikeRawJson(text)) {
          return text;
        }
      } catch {
        // Fallback determinista: la plantilla ya es mensaje de negocio.
      }
      return rendered;
    }

    const composed = (await this.provider.composeReply(input)).trim();
    if (looksLikeRawJson(composed)) {
      return "Estamos procesando tu solicitud. En breve te damos más información.";
    }
    return composed.length > 0
      ? composed
      : "Estamos procesando tu solicitud. En breve te damos más información.";
  }
}

function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return "";
    return String(value);
  });
}

function looksLikeRawJson(text: string): boolean {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
