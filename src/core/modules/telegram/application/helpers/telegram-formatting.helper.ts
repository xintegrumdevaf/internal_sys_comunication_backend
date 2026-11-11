const WORKFLOW_DISPLAY_NAMES: Record<string, string> = {
  SALES: "Ventas y Planes Nuevos",
  SALES_LEAD: "Ventas y Contratación",
  SUPPORT_INTERNET: "Soporte Internet / Fibra",
  BILLING_BALANCE: "Facturación y Saldos",
  BILLING: "Facturación y Cobranzas",
  BILLING_QUERY: "Consultas de Facturación",
  PAYMENT_REPORT: "Reporte de Pago",
  HOME_RELOCATION: "Traslado de Domicilio",
  MOVE_REQUEST: "Traslado de Domicilio",
  CHANGE_PLAN: "Cambio de Plan / Upgrade",
  CANCELLATION: "Bajas y Retenciones",
  GENERAL_INQUIRY: "Consultas Generales",
  GENERAL_QUERY: "Consultas Generales",
  HUMAN_ESCALATION: "Derivación a Asesor",
  TRIAGE: "Clasificación Inicial (Triage)",
};

const ALLOWED_TELEGRAM_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ins",
  "s",
  "strike",
  "del",
  "code",
  "pre",
  "a",
  "blockquote",
]);

/**
 * Escapes HTML special characters for safe Telegram HTML parse_mode rendering.
 */
export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Normalizes LLM output into valid, tag-balanced Telegram-supported HTML,
 * stripping unsupported tags and escaping stray HTML characters in text segments.
 */
export function sanitizeTelegramHtml(raw: string): string {
  let text = raw
    .replace(/```html\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Convert common Markdown bold/headings and block tags before tokenizing
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|tr)>/gi, "\n\n");
  text = text.replace(/<(p|div|h[1-6]|ul|ol|table|thead|tbody|tr)(?:\s[^>]*)?>/gi, "");
  text = text.replace(/<\/(ul|ol|table|thead|tbody)>/gi, "\n");
  text = text.replace(/<li(?:\s[^>]*)?>/gi, "• ");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<t[dh](?:\s[^>]*)?>/gi, "");
  text = text.replace(/<\/t[dh]>/gi, " | ");

  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/g;
  const stack: string[] = [];
  let result = "";
  let lastIndex = 0;

  const escapeSegment = (segment: string): string =>
    segment
      .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  for (const match of text.matchAll(tagRegex)) {
    const fullMatch = match[0];
    const tagName = (match[1] || "").toLowerCase();
    const idx = match.index ?? 0;

    result += escapeSegment(text.slice(lastIndex, idx));
    lastIndex = idx + fullMatch.length;

    if (!ALLOWED_TELEGRAM_TAGS.has(tagName)) {
      continue;
    }

    if (!fullMatch.startsWith("</")) {
      if (tagName === "a") {
        const hrefMatch = fullMatch.match(/href\s*=\s*(["'])(.*?)\1/i);
        if (!hrefMatch) continue;
        stack.push("a");
        result += `<a href="${escapeTelegramHtml(hrefMatch[2] || "")}">`;
      } else {
        stack.push(tagName);
        result += `<${tagName}>`;
      }
    } else {
      const stackIdx = stack.lastIndexOf(tagName);
      if (stackIdx !== -1) {
        while (stack.length > stackIdx) {
          const openTag = stack.pop()!;
          result += `</${openTag}>`;
        }
      } else if (stack.length > 0) {
        const openTag = stack.pop()!;
        result += `</${openTag}>`;
      }
    }
  }

  result += escapeSegment(text.slice(lastIndex));
  while (stack.length > 0) {
    const openTag = stack.pop()!;
    result += `</${openTag}>`;
  }

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Formats an internal workflow identifier into a clear Spanish business label.
 */
export function formatWorkflowDisplayName(workflowType: string): string {
  return WORKFLOW_DISPLAY_NAMES[workflowType] || workflowType.replace(/_/g, " ").toLowerCase();
}

/**
 * Renders structured Ground Truth text cleanly as Telegram HTML when AI synthesis is unavailable.
 */
export function formatGroundTruthFallbackHtml(groundTruth: string): string {
  const lines = groundTruth.split("\n");
  const formatted: string[] = ["🤖 <b>Resumen Operativo Solicitado</b>", ""];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      formatted.push("");
      continue;
    }
    const sectionMatch = line.match(/^===\s*(.+?)\s*===$/);
    if (sectionMatch) {
      formatted.push(`📌 <b>${escapeTelegramHtml(sectionMatch[1] || "")}</b>`);
      continue;
    }
    const bulletKvMatch = line.match(/^[-*]\s+([^:]+):\s*(.+)$/);
    if (bulletKvMatch) {
      const key = escapeTelegramHtml((bulletKvMatch[1] || "").trim());
      const value = escapeTelegramHtml((bulletKvMatch[2] || "").trim());
      formatted.push(`• <b>${key}:</b> <code>${value}</code>`);
      continue;
    }
    const cleanLine = line.replace(/^[-*]\s+/, "");
    formatted.push(`• ${escapeTelegramHtml(cleanLine)}`);
  }

  return formatted.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Computes the UTC Date representing 00:00:00.000 local time in the target IANA timeZone.
 */
export function getStartOfDayInTimeZone(timeZone: string, referenceDate: Date = new Date()): Date {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(referenceDate);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");
    const second = get("second");

    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      const localWallMs = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0);
      const refSecondsMs = Math.floor(referenceDate.getTime() / 1000) * 1000;
      const offsetMs = localWallMs - refSecondsMs;
      const midnightWallMs = Date.UTC(year, month - 1, day, 0, 0, 0);
      return new Date(midnightWallMs - offsetMs);
    }
  } catch {
    // Fallback below if timeZone is invalid
  }

  const fallback = new Date(referenceDate);
  fallback.setUTCHours(0, 0, 0, 0);
  return fallback;
}

/**
 * Computes local midnight N days before referenceDate in the target IANA timeZone.
 */
export function getDaysAgoStartInTimeZone(
  timeZone: string,
  days: number,
  referenceDate: Date = new Date(),
): Date {
  const shifted = new Date(referenceDate.getTime() - days * 24 * 60 * 60 * 1000);
  return getStartOfDayInTimeZone(timeZone, shifted);
}
