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
  sentAt?: string;
  createdAt?: string;
  location?: {
    latitude?: number;
    longitude?: number;
    name?: string;
    address?: string;
    url?: string;
  };
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
      (msg as Record<string, unknown>).senderPhoneNumber as string ||
      (msg as Record<string, unknown>).senderId as string ||
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
  const waProfileName = isOutbound
    ? null
    : msg.sender?.name?.trim() || ((msg as Record<string, unknown>).senderName as string)?.trim() || null;

  const firstAttachment = msg.attachments && msg.attachments.length > 0 ? msg.attachments[0] : null;

  let type = "text";
  let mediaId: string | null = null;
  let mimeType: string | null = null;
  let caption: string | null = msg.caption ?? null;
  let filename: string | null = null;

  // Detección de ubicación geográfica (WhatsApp Location vía Zernio)
  // Zernio envía las coordenadas en `metadata.location` ({ latitude, longitude }),
  // o en `msg.location`, o en `msg.attachments` con type='location'.
  let rawMetadata = msg.metadata;
  if (typeof rawMetadata === "string") {
    try {
      rawMetadata = JSON.parse(rawMetadata);
    } catch {
      rawMetadata = undefined;
    }
  }

  let rawDirectLocation = msg.location;
  if (typeof rawDirectLocation === "string") {
    try {
      rawDirectLocation = JSON.parse(rawDirectLocation);
    } catch {
      rawDirectLocation = undefined;
    }
  }

  const typedPayload = payload as Record<string, unknown>;
  const payloadMeta = (typedPayload.metadata || (typedPayload.data as Record<string, unknown> | undefined)?.metadata) as Record<string, unknown> | undefined;
  const payloadLocation = (typedPayload.location || (typedPayload.data as Record<string, unknown> | undefined)?.location) as Record<string, unknown> | undefined;

  const metaLocation = ((rawMetadata as Record<string, unknown> | undefined)?.location || rawMetadata || payloadMeta?.location || payloadMeta) as Record<string, unknown> | undefined;
  const directLocation = (rawDirectLocation || payloadLocation) as Record<string, unknown> | undefined;
  const locationAttachment = msg.attachments?.find(
    (att) => att.type === "location" || (typeof (att as Record<string, unknown>).latitude === "number" && typeof (att as Record<string, unknown>).longitude === "number"),
  ) as Record<string, unknown> | undefined;

  const parseNum = (val: unknown): number | undefined => {
    if (typeof val === "number" && !Number.isNaN(val)) return val;
    if (typeof val === "string" && val.trim()) {
      const n = Number.parseFloat(val.trim());
      if (!Number.isNaN(n)) return n;
    }
    return undefined;
  };

  let latCandidate =
    parseNum(directLocation?.latitude) ??
    parseNum(directLocation?.lat) ??
    parseNum(metaLocation?.latitude) ??
    parseNum(metaLocation?.lat) ??
    parseNum(locationAttachment?.latitude) ??
    parseNum(locationAttachment?.lat);

  let lngCandidate =
    parseNum(directLocation?.longitude) ??
    parseNum(directLocation?.lng) ??
    parseNum(directLocation?.lon) ??
    parseNum(metaLocation?.longitude) ??
    parseNum(metaLocation?.lng) ??
    parseNum(metaLocation?.lon) ??
    parseNum(locationAttachment?.longitude) ??
    parseNum(locationAttachment?.lng);

  const locName =
    (typeof directLocation?.name === "string" ? directLocation.name : undefined) ??
    (typeof metaLocation?.name === "string" ? metaLocation.name : undefined) ??
    (typeof locationAttachment?.name === "string" ? (locationAttachment.name as string) : undefined);

  const locAddress =
    (typeof directLocation?.address === "string" ? directLocation.address : undefined) ??
    (typeof metaLocation?.address === "string" ? metaLocation.address : undefined) ??
    (typeof locationAttachment?.address === "string" ? (locationAttachment.address as string) : undefined);

  const locUrl =
    (typeof directLocation?.url === "string" ? directLocation.url : undefined) ??
    (typeof metaLocation?.url === "string" ? metaLocation.url : undefined) ??
    (typeof locationAttachment?.url === "string" ? (locationAttachment.url as string) : undefined);

  const rawText = ((msg.text ?? (msg as Record<string, unknown>).message as string) ?? "").trim();

  // Si no vinieron en objetos estructurados, verificar si el texto trae coordenadas
  if (latCandidate === undefined && rawText) {
    const coordMatch = rawText.match(/([-+]?\d{1,2}\.\d+)\s*,\s*([-+]?\d{1,3}\.\d+)/);
    if (coordMatch?.[1] && coordMatch[2]) {
      latCandidate = Number.parseFloat(coordMatch[1]);
      lngCandidate = Number.parseFloat(coordMatch[2]);
    }
  }

  // Si el texto es '📍 Location' y no trajo coordenadas en el payload del webhook, consultar Zernio API como fallback
  if (latCandidate === undefined && msg.conversationId && (rawText === "📍 Location" || rawText.includes("Location"))) {
    try {
      const apiKey = process.env.ZERNIO_API_KEY;
      if (apiKey) {
        const queryUrl = `https://zernio.com/api/v1/inbox/conversations/${encodeURIComponent(msg.conversationId)}/messages?limit=10`;
        const zRes = await fetch(queryUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (zRes.ok) {
          const zData = (await zRes.json()) as { data?: unknown[]; messages?: unknown[] };
          const msgList = (zData.data || zData.messages || []) as Array<Record<string, unknown>>;
          const targetExternal = msg.platformMessageId || msg.id;
          const matchedZMsg = msgList.find((m) => m.id === targetExternal || m.platformMessageId === targetExternal);
          const zMeta = matchedZMsg?.metadata as Record<string, unknown> | undefined;
          const zLoc = (zMeta?.location || matchedZMsg?.location) as Record<string, unknown> | undefined;
          if (zLoc) {
            latCandidate = parseNum(zLoc.latitude ?? zLoc.lat);
            lngCandidate = parseNum(zLoc.longitude ?? zLoc.lng ?? zLoc.lon);
          }
        }
      }
    } catch {
      // Ignorar fallos de red en fallback
    }
  }

  if (latCandidate !== undefined && lngCandidate !== undefined) {
    type = "location";
    const googleMapsUrl = locUrl || `https://maps.google.com/?q=${latCandidate},${lngCandidate}`;
    const parts: string[] = [`Ubicación GPS: ${latCandidate}, ${lngCandidate}`];
    if (locName) parts.push(locName);
    if (locAddress && locAddress !== locName) parts.push(locAddress);
    parts.push(googleMapsUrl);

    caption = locName || locAddress || (rawText.length > 0 && rawText !== "📍 Location" ? rawText : "Ubicación compartida");
    filename = `${latCandidate},${lngCandidate}`;
    mediaId = googleMapsUrl;
  } else if (firstAttachment) {
    type = firstAttachment.type || "document";
    mediaId = firstAttachment.url || null;
    mimeType = firstAttachment.mimeType || null;
    caption = firstAttachment.caption || msg.caption || null;
    filename = firstAttachment.filename || firstAttachment.name || null;
  }

  let body = "";
  if (type === "location" && latCandidate !== undefined && lngCandidate !== undefined) {
    const googleMapsUrl = locUrl || `https://maps.google.com/?q=${latCandidate},${lngCandidate}`;
    const parts: string[] = [`Ubicación GPS: ${latCandidate}, ${lngCandidate}`];
    if (locName) parts.push(locName);
    if (locAddress && locAddress !== locName) parts.push(locAddress);
    parts.push(googleMapsUrl);
    body = parts.join(" - ");
  } else {
    body = rawText.length > 0 ? rawText : (caption ?? "").trim();
  }

  let createdAt: Date | undefined;
  if (msg.sentAt) {
    const d = new Date(msg.sentAt);
    if (!Number.isNaN(d.getTime())) createdAt = d;
  } else if (msg.createdAt) {
    const d = new Date(msg.createdAt);
    if (!Number.isNaN(d.getTime())) createdAt = d;
  } else if (msg.metadata?.timestamp) {
    const d = new Date(Number(msg.metadata.timestamp) * 1000);
    if (!Number.isNaN(d.getTime())) createdAt = d;
  }

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
      createdAt,
    },
  ];
}
