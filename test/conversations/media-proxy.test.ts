import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createConversationsRouter } from "../../src/core/modules/conversations/presentation/conversations.router";

vi.mock("../../src/shared/config/env", () => ({
  env: {
    ZERNIO_API_KEY: "zernio-secret-key",
    WHATSAPP_PROVIDER: "zernio",
    WHATSAPP_ACCESS_TOKEN: "meta-access-token",
  },
}));

vi.mock("../../src/shared/http/require-auth", () => ({
  requireAuth: () => ({ id: "agent-1", role: "agent" }),
}));

describe("ConversationsRouter - /api/media Proxy", () => {
  it("descarga imágenes desde una URL de Zernio enviando Bearer ZERNIO_API_KEY", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: async () => Buffer.from("fake-image-bytes"),
    });
    global.fetch = mockFetch;

    const router = createConversationsRouter({
      listConversations: {} as any,
      listMessages: {} as any,
      replyAsHuman: {} as any,
      takeControl: {} as any,
      markAsRead: {} as any,
      caseRepo: {} as any,
    });

    const app = express();
    app.use(router);

    const targetUrl = "https://zernio.com/api/v1/inbox/media/receipt.jpg";
    const res = await request(app).get(`/api/media?url=${encodeURIComponent(targetUrl)}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(mockFetch).toHaveBeenCalledWith(
      targetUrl,
      expect.objectContaining({
        headers: { Authorization: "Bearer zernio-secret-key" },
      }),
    );
  });

  it("descarga imágenes utilizando ID numérico de Meta Cloud API", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ url: "https://lookaside.fbsbx.com/file.jpg", mime_type: "image/png" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => Buffer.from("meta-image-bytes"),
      });
    global.fetch = mockFetch;

    const router = createConversationsRouter({
      listConversations: {} as any,
      listMessages: {} as any,
      replyAsHuman: {} as any,
      takeControl: {} as any,
      markAsRead: {} as any,
      caseRepo: {} as any,
    });

    const app = express();
    app.use(router);

    const res = await request(app).get("/api/media/1092837465");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("descarga imágenes utilizando rutas relativas de Zernio (/api/media/api/v1/whatsapp/media/...)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: async () => Buffer.from("zernio-relative-bytes"),
    });
    global.fetch = mockFetch;

    const router = createConversationsRouter({
      listConversations: {} as any,
      listMessages: {} as any,
      replyAsHuman: {} as any,
      takeControl: {} as any,
      markAsRead: {} as any,
      caseRepo: {} as any,
    });

    const app = express();
    app.use(router);

    const res = await request(app).get("/api/media/api/v1/whatsapp/media/1379572820964779");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://zernio.com/api/v1/whatsapp/media/1379572820964779",
      expect.objectContaining({
        headers: { Authorization: "Bearer zernio-secret-key" },
      }),
    );
  });

  it("descarga imágenes utilizando rutas relativas de Zernio preservando el query param accountId", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: async () => Buffer.from("zernio-query-bytes"),
    });
    global.fetch = mockFetch;

    const router = createConversationsRouter({
      listConversations: {} as any,
      listMessages: {} as any,
      replyAsHuman: {} as any,
      takeControl: {} as any,
      markAsRead: {} as any,
      caseRepo: {} as any,
    });

    const app = express();
    app.use(router);

    const res = await request(app).get(
      "/api/media/api/v1/whatsapp/media/1073892395459784?accountId=6aa32c44726ebfe037d67a70",
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://zernio.com/api/v1/whatsapp/media/1073892395459784?accountId=6aa32c44726ebfe037d67a70",
      expect.objectContaining({
        headers: { Authorization: "Bearer zernio-secret-key" },
      }),
    );
  });

  it("repara URLs completas de Zernio con barras colapsadas de protocolo (/api/media/https:/zernio.com/...)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: async () => Buffer.from("zernio-repaired-bytes"),
    });
    global.fetch = mockFetch;

    const router = createConversationsRouter({
      listConversations: {} as any,
      listMessages: {} as any,
      replyAsHuman: {} as any,
      takeControl: {} as any,
      markAsRead: {} as any,
      caseRepo: {} as any,
    });

    const app = express();
    app.use(router);

    const res = await request(app).get(
      "/api/media/https:/zernio.com/api/v1/whatsapp/media/28447679298223789?accountId=6aa32c44726ebfe037d67a70",
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://zernio.com/api/v1/whatsapp/media/28447679298223789?accountId=6aa32c44726ebfe037d67a70",
      expect.objectContaining({
        headers: { Authorization: "Bearer zernio-secret-key" },
      }),
    );
  });
});

