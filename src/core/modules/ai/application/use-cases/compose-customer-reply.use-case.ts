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
        if (text.length > 0 && !looksLikeRawJson(text) && includesRequiredFacts(text, input.stepOutcome.result)) {
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

function formatAmount(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n.toFixed(2);
  }
  return null;
}

/**
 * Si el resultado trae un monto (debt/amount), el mensaje naturalizado debe
 * incluirlo; si el LLM lo omitió, se descarta y se usa la plantilla renderizada.
 */
function includesRequiredFacts(text: string, result: Record<string, unknown> | undefined): boolean {
  if (!result) return true;
  const debt = formatAmount(result.debt) ?? formatAmount(result.amount);
  if (!debt) return true;
  const normalizedText = text.replace(/,/g, ".");
  return normalizedText.includes(debt) || normalizedText.includes(String(result.debt ?? result.amount));
}
