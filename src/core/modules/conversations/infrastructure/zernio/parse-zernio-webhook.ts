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
  recipient?: {
    id?: string;
    name?: string;
    username?: string;
    phone?: string;
  };
  recipientId?: string;
  participantId?: string;
  participantUsername?: string;
  to?: string;
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

function isBusinessAccount(phone: string): boolean {
  const clean = phone.replace(/\D/g, "");
  if (!clean) return false;
  if (clean.length > 14 && (clean.startsWith("1042") || clean.startsWith("1348") || clean.startsWith("3223"))) {
    return true;
  }
  return false;
}

/**
 * Anti-Corruption Layer: traduce el payload de Zernio (evento message.received / message.sent)
 * al formato canónico NormalizedInboundMessage que consume ReceiveInboundMessageUseCase.
 */
export async function parseZernioWebhookPayload(
  payload: unknown,
  options?: { zernioSender?: import("./zernio-sender.http").ZernioSenderHttp },
): Promise<NormalizedInboundMessage[]> {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const typed = payload as ZernioWebhookPayload;

  const statusOnlyEvents = ["message.delivered", "message.read", "message.failed", "message.deleted", "message.status", "message.status_update"];
  const event = String(typed.event || "").toLowerCase();
  if (!typed.message || !event.startsWith("message.") || statusOnlyEvents.includes(event)) {
    return [];
  }

  const msg = typed.message;
  const isOutbound = msg.direction === "outgoing" || msg.fromMe === true;

  // Extraer el teléfono del participante/destinatario (normalizado sin caracteres especiales)
  let rawPhoneSource = "";

  if (isOutbound) {
    rawPhoneSource =
      msg.recipient?.id ||
      msg.recipient?.username ||
      msg.recipient?.phone ||
      msg.recipientId ||
      msg.participantId ||
      msg.participantUsername ||
      msg.to ||
      (typeof msg.metadata?.to === "string" ? msg.metadata.to : "") ||
      (typeof msg.metadata?.phone === "string" ? msg.metadata.phone : "") ||
      (typeof msg.metadata?.recipient === "string" ? msg.metadata.recipient : "");
  } else {
    rawPhoneSource =
      msg.sender?.id ||
      msg.sender?.username ||
      msg.participantId ||
      msg.participantUsername ||
      "";
  }

  let waPhone = rawPhoneSource.replace(/\D/g, "");

  // Si no se encontró teléfono o es una cuenta comercial en mensaje saliente, intentar resolver por el caché o la API de Zernio
  if ((!waPhone || isBusinessAccount(waPhone)) && msg.conversationId && options?.zernioSender) {
    const resolvedPhone = await options.zernioSender.resolvePhoneByConversationId(msg.conversationId);
    if (resolvedPhone) {
      waPhone = resolvedPhone;
    }
  }

  // Si no hay teléfono válido o si coincide con un ID de canal comercial (ej. 1042377638962976), descartar para no crear chats provisionales
  if (!waPhone || isBusinessAccount(waPhone)) {
    return [];
  }

  const externalId = msg.platformMessageId || msg.id;
  const waProfileName = isOutbound ? null : msg.sender?.name?.trim() || null;

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
      direction: isOutbound ? "outbound" : "inbound",
      author: isOutbound ? "agent" : "customer",
    },
  ];
}
