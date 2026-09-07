import type { NormalizedInboundMessage } from "../whatsapp/parse-whatsapp-webhook";

/**
 * Payload estructurado de eventos de webhook de Zernio (Inbox).
 */
export type ZernioWebhookAttachment = {
  type: string;
  url?: string;
  mimeType?: string;
  name?: string;
  filename?: string;
  caption?: string;
};

export type ZernioWebhookMessage = {
  id: string;
  conversationId: string;
  platform?: string;
  platformMessageId?: string;
  direction?: "incoming" | "outgoing";
  fromMe?: boolean;
  text?: string | null;
  caption?: string | null;
  attachments?: ZernioWebhookAttachment[];
  sender?: {
    id?: string;
    name?: string;
    username?: string;
  };
  participantId?: string;
  metadata?: Record<string, unknown>;
};

export type ZernioWebhookPayload = {
  id: string;
  event: string;
  message?: ZernioWebhookMessage;
  account?: {
    id?: string;
    username?: string;
  };
};

/**
 * Anti-Corruption Layer: traduce el payload de Zernio (evento message.received)
 * al formato canónico NormalizedInboundMessage que consume ReceiveInboundMessageUseCase.
 */
export function parseZernioWebhookPayload(payload: unknown): NormalizedInboundMessage[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const typed = payload as ZernioWebhookPayload;

  // Solo procesamos eventos de mensaje entrante
  if (typed.event !== "message.received" || !typed.message) {
    return [];
  }

  const msg = typed.message;

  // Descartar mensajes salientes producidos por el bot o la plataforma para evitar loops
  if (msg.direction === "outgoing" || msg.fromMe === true) {
    return [];
  }

  // Extraer el teléfono del remitente (normalizado sin caracteres especiales)
  const rawSender = msg.sender?.id || msg.sender?.username || msg.participantId || "";
  const waPhone = rawSender.replace(/\D/g, "");

  if (!waPhone) {
    return [];
  }

  const externalId = msg.platformMessageId || msg.id;
  const waProfileName = msg.sender?.name?.trim() || null;

  const firstAttachment = msg.attachments && msg.attachments.length > 0 ? msg.attachments[0] : null;

  let type = "text";
  let mediaId: string | null = null;
  let mimeType: string | null = null;
  let caption: string | null = msg.caption ?? null;
  let filename: string | null = null;

  if (firstAttachment) {
    type = firstAttachment.type || "document";
    mediaId = firstAttachment.url || null;
    mimeType = firstAttachment.mimeType || null;
    caption = firstAttachment.caption || msg.caption || null;
    filename = firstAttachment.filename || firstAttachment.name || null;
  }

  const rawText = (msg.text ?? "").trim();
  const body = rawText.length > 0 ? rawText : (caption ?? "").trim();

  return [
    {
      waPhone,
      externalId,
      body,
      type,
      mediaId,
      mimeType,
      caption,
      filename,
      waProfileName,
    },
  ];
}
