import { describe, expect, it } from "vitest";
import {
  parseWhatsAppWebhookPayload,
  parseWhatsAppWebhookEdits,
} from "../../src/core/modules/conversations/infrastructure/whatsapp/parse-whatsapp-webhook";

/**
 * Payloads reales segun "messages webhook reference" de Meta
 * (developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components) —
 * confirma que `contacts[].profile.name` se captura sin llamada extra a la API.
 */
describe("parseWhatsAppWebhookPayload — contacts[].profile.name", () => {
  it("extrae el nombre de perfil de WhatsApp del mensaje de texto", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.ABC",
                    type: "text",
                    text: { body: "Does it come in another color?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const [normalized] = parseWhatsAppWebhookPayload(payload);
    expect(normalized?.waProfileName).toBe("Sheena Nelson");
    expect(normalized?.waPhone).toBe("16505551234");
  });

  it("devuelve null si el payload no trae contacts (nunca inventa un nombre)", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: "16505551234", id: "wamid.ABC", type: "text", text: { body: "hola" } }],
              },
            },
          ],
        },
      ],
    };

    const [normalized] = parseWhatsAppWebhookPayload(payload);
    expect(normalized?.waProfileName).toBeNull();
  });

  it("empareja el contacto correcto por wa_id cuando hay varios mensajes en el mismo batch", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [
                  { profile: { name: "Ana" }, wa_id: "111" },
                  { profile: { name: "Beto" }, wa_id: "222" },
                ],
                messages: [
                  { from: "222", id: "wamid.2", type: "text", text: { body: "hola de Beto" } },
                  { from: "111", id: "wamid.1", type: "text", text: { body: "hola de Ana" } },
                ],
              },
            },
          ],
        },
      ],
    };

    const normalized = parseWhatsAppWebhookPayload(payload);
    expect(normalized.find((m) => m.externalId === "wamid.1")?.waProfileName).toBe("Ana");
    expect(normalized.find((m) => m.externalId === "wamid.2")?.waProfileName).toBe("Beto");
  });

  it("tambien captura el nombre en mensajes con media (imagen/audio/documento)", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ profile: { name: "Carla" }, wa_id: "333" }],
                messages: [
                  {
                    from: "333",
                    id: "wamid.img",
                    type: "image",
                    image: { id: "media-1", mime_type: "image/jpeg", caption: "mira esto" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const [normalized] = parseWhatsAppWebhookPayload(payload);
    expect(normalized?.waProfileName).toBe("Carla");
    expect(normalized?.mediaId).toBe("media-1");
  });

  it("ignora mensajes de tipo edit en parseWhatsAppWebhookPayload", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.EDIT1",
                    type: "edit",
                    timestamp: "1710000000",
                    edit: {
                      original_message_id: "wamid.ORIG1",
                      message: { text: { body: "Texto corregido" } },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const messages = parseWhatsAppWebhookPayload(payload);
    expect(messages).toHaveLength(0);
  });
});

describe("parseWhatsAppWebhookEdits", () => {
  it("extrae correctamente la edición de un mensaje con original_message_id y nuevo body", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.EDIT_EVENT_123",
                    type: "edit",
                    timestamp: "1710000005",
                    edit: {
                      original_message_id: "wamid.ORIG_MSG_001",
                      message: {
                        text: {
                          body: "Mi número de cédula corregido es 12345678",
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const edits = parseWhatsAppWebhookEdits(payload);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      waPhone: "16505551234",
      originalExternalId: "wamid.ORIG_MSG_001",
      newExternalId: "wamid.EDIT_EVENT_123",
      newBody: "Mi número de cédula corregido es 12345678",
      timestamp: "1710000005",
    });
  });

  it("devuelve array vacío si no hay mensajes de tipo edit", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.NORM_1",
                    type: "text",
                    text: { body: "mensaje normal" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const edits = parseWhatsAppWebhookEdits(payload);
    expect(edits).toEqual([]);
  });
});

