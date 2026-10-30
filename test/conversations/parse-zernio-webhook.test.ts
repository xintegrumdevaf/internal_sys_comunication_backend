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

  it("extrae correctamente ubicacion reenviada con metadata.location y senderPhoneNumber", async () => {
    const payload = {
      id: "evt_loc",
      event: "message.received",
      message: {
        id: "msg_loc_1",
        conversationId: "conv_xyz",
        platformMessageId: "wamid.LOC123",
        direction: "incoming",
        message: "📍 Location",
        senderPhoneNumber: "+593 99 857 6466",
        senderName: "Jean",
        metadata: {
          location: {
            latitude: -0.2661031,
            longitude: -78.4977984,
          },
        },
      },
    };

    const [normalized] = await parseZernioWebhookPayload(payload);
    expect(normalized).toBeDefined();
    expect(normalized!.waPhone).toBe("593998576466");
    expect(normalized!.externalId).toBe("wamid.LOC123");
    expect(normalized!.type).toBe("location");
    expect(normalized!.filename).toBe("-0.2661031,-78.4977984");
    expect(normalized!.mediaId).toBe("https://maps.google.com/?q=-0.2661031,-78.4977984");
    expect(normalized!.body).toContain("Ubicación GPS: -0.2661031, -78.4977984");
  });

  it("extrae correctamente un video adjunto cuando viene en attachments", async () => {
    const payload = {
      id: "evt_vid",
      event: "message.received",
      message: {
        id: "msg_vid_1",
        conversationId: "conv_xyz",
        platform: "whatsapp",
        platformMessageId: "wamid.VID101",
        direction: "incoming",
        text: "",
        attachments: [
          {
            type: "video",
            url: "https://zernio.com/api/v1/whatsapp/media/1042377638962976/video_test",
            mimeType: "video/mp4",
            caption: "Video desde el router",
          },
        ],
        sender: {
          id: "593994844050",
          name: "Marcela Carpio",
        },
      },
    };

    const [normalized] = await parseZernioWebhookPayload(payload);
    expect(normalized).toBeDefined();
    expect(normalized!.waPhone).toBe("593994844050");
    expect(normalized!.externalId).toBe("wamid.VID101");
    expect(normalized!.type).toBe("video");
    expect(normalized!.mediaId).toBe("https://zernio.com/api/v1/whatsapp/media/1042377638962976/video_test");
    expect(normalized!.caption).toBe("Video desde el router");
    expect(normalized!.body).toBe("Video desde el router");
  });

  it("identifica video si type es 'file' pero mimeType es 'video/mp4'", async () => {
    const payload = {
      id: "evt_vid2",
      event: "message.received",
      message: {
        id: "msg_vid_2",
        conversationId: "conv_xyz",
        platform: "whatsapp",
        platformMessageId: "wamid.VID102",
        direction: "incoming",
        text: "",
        attachments: [
          {
            type: "file",
            filename: "router_recording.mp4",
            url: "https://zernio.com/api/v1/whatsapp/media/1042377638962976/file_test",
            mimeType: "video/mp4",
          },
        ],
        sender: {
          id: "593994844050",
          name: "Marcela Carpio",
        },
      },
    };

    const [normalized] = await parseZernioWebhookPayload(payload);
    expect(normalized).toBeDefined();
    expect(normalized!.type).toBe("video");
    expect(normalized!.body).toBe("[video]");
    expect(normalized!.filename).toBe("router_recording.mp4");
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
