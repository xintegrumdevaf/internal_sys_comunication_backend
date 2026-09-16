import { describe, expect, it } from "vitest";
import { parseZernioWebhookPayload } from "../../src/core/modules/conversations/infrastructure/zernio/parse-zernio-webhook";
import { verifyZernioSignature } from "../../src/shared/http/zernio-signature";
import { createHmac } from "node:crypto";

describe("parseZernioWebhookPayload", () => {
  it("extrae correctamente un mensaje entrante de texto", async () => {
    const payload = {
      id: "evt_12345",
      event: "message.received",
      message: {
        id: "msg_abc",
        conversationId: "conv_xyz",
        platform: "whatsapp",
        platformMessageId: "wamid.HBg12345",
        direction: "incoming",
        text: "Hola, necesito soporte con mi servicio de internet",
        sender: {
          id: "+593 99 354 6974",
          name: "Angel Fajardo",
          username: "+593993546974",
        },
      },
    };

    const [normalized] = await parseZernioWebhookPayload(payload);
    expect(normalized).toBeDefined();
    expect(normalized!.waPhone).toBe("593993546974");
    expect(normalized!.externalId).toBe("wamid.HBg12345");
    expect(normalized!.body).toBe("Hola, necesito soporte con mi servicio de internet");
    expect(normalized!.type).toBe("text");
    expect(normalized!.waProfileName).toBe("Angel Fajardo");
    expect(normalized!.mediaId).toBeNull();
  });

  it("extrae adjunto cuando viene en attachments", async () => {
    const payload = {
      id: "evt_img",
      event: "message.received",
      message: {
        id: "msg_img_1",
        conversationId: "conv_xyz",
        platform: "whatsapp",
        platformMessageId: "wamid.IMG999",
        direction: "incoming",
        text: "",
        attachments: [
          {
            type: "image",
            url: "https://zernio.com/api/v1/whatsapp/media/1042377638962976/media_abc",
            mimeType: "image/jpeg",
            caption: "Comprobante de pago adjunto",
          },
        ],
        sender: {
          id: "593981170640",
          name: "Maria Lopez",
        },
      },
    };

    const [normalized] = await parseZernioWebhookPayload(payload);
    expect(normalized).toBeDefined();
    expect(normalized!.waPhone).toBe("593981170640");
    expect(normalized!.externalId).toBe("wamid.IMG999");
    expect(normalized!.type).toBe("image");
    expect(normalized!.mediaId).toBe("https://zernio.com/api/v1/whatsapp/media/1042377638962976/media_abc");
    expect(normalized!.caption).toBe("Comprobante de pago adjunto");
    expect(normalized!.body).toBe("Comprobante de pago adjunto");
  });

  it("normaliza correctamente mensajes salientes (direction === 'outgoing' o fromMe === true)", async () => {
    const payload = {
      id: "evt_out",
      event: "message.sent",
      message: {
        id: "msg_out_1",
        conversationId: "conv_xyz",
        participantId: "+593 99 354 6974",
        direction: "outgoing",
        fromMe: true,
        text: "Mensaje enviado por el vendedor desde WhatsApp movil",
      },
    };

    const [normalized] = await parseZernioWebhookPayload(payload);
    expect(normalized).toBeDefined();
    expect(normalized!.waPhone).toBe("593993546974");
    expect(normalized!.direction).toBe("outbound");
    expect(normalized!.author).toBe("agent");
    expect(normalized!.body).toBe("Mensaje enviado por el vendedor desde WhatsApp movil");
  });

  it("descarta eventos que no sean message.received", async () => {
    const payload = {
      id: "evt_other",
      event: "message.delivered",
      message: {
        id: "msg_deliv",
      },
    };

    const messages = await parseZernioWebhookPayload(payload);
    expect(messages).toHaveLength(0);
  });
});

describe("verifyZernioSignature", () => {
  const secret = "test-webhook-secret-123";
  const body = Buffer.from(JSON.stringify({ event: "message.received" }));

  it("valida correctamente una firma valida", () => {
    const validSignature = createHmac("sha256", secret).update(body).digest("hex");
    const isValid = verifyZernioSignature(body, validSignature, secret);
    expect(isValid).toBe(true);
  });

  it("rechaza firma incorrecta", () => {
    const invalidSignature = "deadbeef1234567890abcdefdeadbeef1234567890abcdefdeadbeef12345678";
    const isValid = verifyZernioSignature(body, invalidSignature, secret);
    expect(isValid).toBe(false);
  });

  it("permite bypass cuando no hay secret configurado en el servidor", () => {
    const isValid = verifyZernioSignature(body, undefined, undefined);
    expect(isValid).toBe(true);
  });
});
