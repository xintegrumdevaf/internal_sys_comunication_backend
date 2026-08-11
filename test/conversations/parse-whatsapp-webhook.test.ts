import { describe, expect, it } from "vitest";
import { parseWhatsAppWebhookPayload } from "../../src/core/modules/conversations/infrastructure/whatsapp/parse-whatsapp-webhook";

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
});
