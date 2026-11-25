/**
 * Helper puro de dominio/ACL para diferenciar mensajes o adjuntos entrantes
 * marcados como no soportados/no disponibles por WhatsApp (Meta Cloud API o su capa de Inbox).
 * Evita mezclar placeholders técnicos como "[Unsupported message]" con texto real del cliente.
 */

export const UNSUPPORTED_INTERNAL_BODY = "[unsupported]";

const KNOWN_META_UNSUPPORTED_HINTS: Record<string, string> = {
  "131051": "Formato de mensaje no soportado por el canal (revisar en WhatsApp Web o celular)",
  "131052": "No se pudo descargar la imagen o archivo desde WhatsApp (revisar en WhatsApp Web o celular)",
  "131053": "Tipo de archivo no admitido para descarga automática (revisar en WhatsApp Web o celular)",
  "131060": "Mensaje temporalmente no sincronizado entre el teléfono y la plataforma (revisar en WhatsApp Web o celular)",
};

function sanitizeTechnicalBrand(text: string): string {
  return text
    .replace(/\bzernio\b/gi, "la plataforma de mensajería")
    .replace(/\bcloud\s*api\b/gi, "WhatsApp")
    .trim();
}

export function extractUnsupportedDetail(input: {
  type?: string | null;
  text?: string | null;
  metadata?: Record<string, unknown> | null;
  errors?: Array<{ code?: number | string; title?: string; message?: string; error_data?: { details?: string } }>;
  attachments?: unknown[] | null;
}): { isUnsupported: boolean; code: string | null; label: string | null } {
  const rawType = (input.type ?? "").trim().toLowerCase();
  const rawText = (input.text ?? "").trim();
  const normalizedText = rawText.toLowerCase();
  const hasAttachments = Array.isArray(input.attachments) && input.attachments.length > 0;

  const meta = input.metadata ?? undefined;
  const metaUnsupported =
    meta && typeof meta.unsupported === "object" && meta.unsupported !== null
      ? (meta.unsupported as Record<string, unknown>)
      : meta?.unsupported;

  const firstError = Array.isArray(input.errors) && input.errors.length > 0 ? input.errors[0] : undefined;

  const isUnsupportedText =
    !hasAttachments &&
    (normalizedText === "[unsupported message]" ||
      normalizedText === "[unsupported]" ||
      normalizedText === "unsupported message");

  const isUnsupported =
    rawType === "unsupported" ||
    Boolean(metaUnsupported) ||
    Boolean(firstError && rawType === "unsupported") ||
    isUnsupportedText;

  if (!isUnsupported) {
    return { isUnsupported: false, code: null, label: null };
  }

  let codeRaw: unknown = firstError?.code;
  let detailRaw: unknown =
    firstError?.error_data?.details ?? firstError?.message ?? firstError?.title;

  if (typeof metaUnsupported === "object" && metaUnsupported !== null) {
    const obj = metaUnsupported as Record<string, unknown>;
    codeRaw ??= obj.code ?? obj.errorCode;
    detailRaw ??= obj.details ?? obj.message ?? obj.title ?? obj.reason;
  } else if (typeof metaUnsupported === "string" || typeof metaUnsupported === "number") {
    detailRaw ??= metaUnsupported;
  }

  const code =
    codeRaw !== undefined && codeRaw !== null && String(codeRaw).trim() !== ""
      ? String(codeRaw).trim()
      : null;

  const hintFromCode = code ? KNOWN_META_UNSUPPORTED_HINTS[code] : undefined;
  const fallbackDetail =
    typeof detailRaw === "string" && detailRaw.trim().length > 0
      ? sanitizeTechnicalBrand(detailRaw.trim())
      : null;

  const label =
    hintFromCode ??
    (code && fallbackDetail
      ? `Ref. ${code}: ${fallbackDetail}`
      : code
        ? `Ref. ${code}: Revisar mensaje en WhatsApp Web o en el teléfono principal`
        : fallbackDetail ?? "Elemento multimedia o mensaje disponible solo en WhatsApp Web o celular");

  return { isUnsupported: true, code, label };
}

export function isUnsupportedMessageRecord(msg: {
  type?: string | null;
  body?: string | null;
}): boolean {
  const t = (msg.type ?? "").trim().toLowerCase();
  if (t === "unsupported") return true;
  const b = (msg.body ?? "").trim().toLowerCase();
  return b === "[unsupported]" || b === "[unsupported message]";
}
