/**
 * Anti-Corruption Layer (docs/skills/design-patterns-backend.md): traduce el
 * payload crudo de WhatsApp Cloud API a la forma que espera
 * ReceiveInboundMessageUseCase. El dominio nunca conoce la forma exacta
 * del payload de Meta directamente.
 */

type WhatsAppMediaObject = {
  id: string;
  mime_type: string;
  caption?: string;
};

type WhatsAppDocumentObject = WhatsAppMediaObject & { filename?: string };

type WhatsAppInboundMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body: string };
  image?: WhatsAppMediaObject;
  audio?: WhatsAppMediaObject;
  video?: WhatsAppMediaObject;
  document?: WhatsAppDocumentObject;
};

type WhatsAppContact = {
  wa_id?: string;
  profile?: { name?: string };
};

type WhatsAppWebhookPayload = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppInboundMessage[];
        contacts?: WhatsAppContact[];
      };
    }>;
  }>;
};

export type NormalizedInboundMessage = {
  waPhone: string;
  externalId: string;
  body: string;
  type: string;
  mediaId: string | null;
  mimeType: string | null;
  caption: string | null;
  filename: string | null;
  /**
   * Nombre de perfil/agenda de WhatsApp (`contacts[].profile.name`) — viene
   * gratis en cada webhook entrante, sin llamada extra a la API de Meta.
   * `null` si el payload no trae `contacts` para este `wa_id` (no debería
   * pasar en producción, pero el parser nunca asume que siempre está).
   */
  waProfileName: string | null;
};

export function parseWhatsAppWebhookPayload(payload: unknown): NormalizedInboundMessage[] {
  const typed = payload as WhatsAppWebhookPayload;
  const normalized: NormalizedInboundMessage[] = [];

  for (const entry of typed.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const profileNameByWaId = new Map<string, string>();
      for (const contact of change.value?.contacts ?? []) {
        if (contact.wa_id && contact.profile?.name) {
          profileNameByWaId.set(contact.wa_id, contact.profile.name);
        }
      }

      for (const raw of change.value?.messages ?? []) {
        normalized.push(normalizeMessage(raw, profileNameByWaId.get(raw.from) ?? null));
      }
    }
  }

  return normalized;
}

function normalizeMessage(raw: WhatsAppInboundMessage, waProfileName: string | null): NormalizedInboundMessage {
  const base = { waPhone: raw.from, externalId: raw.id, type: raw.type, waProfileName };

  switch (raw.type) {
    case "text":
      return { ...base, body: raw.text?.body ?? "", mediaId: null, mimeType: null, caption: null, filename: null };
    case "image":
      return mediaMessage(base, raw.image);
    case "audio":
      return mediaMessage(base, raw.audio);
    case "video":
      return mediaMessage(base, raw.video);
    case "document":
      return {
        ...base,
        body: raw.document?.caption ?? "",
        mediaId: raw.document?.id ?? null,
        mimeType: raw.document?.mime_type ?? null,
        caption: raw.document?.caption ?? null,
        filename: raw.document?.filename ?? null,
      };
    default:
      return { ...base, body: "", mediaId: null, mimeType: null, caption: null, filename: null };
  }
}

function mediaMessage(
  base: { waPhone: string; externalId: string; type: string; waProfileName: string | null },
  media: WhatsAppMediaObject | undefined,
): NormalizedInboundMessage {
  return {
    ...base,
    body: media?.caption ?? "",
    mediaId: media?.id ?? null,
    mimeType: media?.mime_type ?? null,
    caption: media?.caption ?? null,
    filename: null,
  };
}
