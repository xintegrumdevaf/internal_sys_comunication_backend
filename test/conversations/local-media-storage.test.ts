import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/shared/config/env";
import { LocalMediaStorageAdapter } from "../../src/core/modules/conversations/infrastructure/storage/local-media-storage.adapter";
import { createConversationsRouter, _clearMediaCacheForTesting } from "../../src/core/modules/conversations/presentation/conversations.router";
import { ReplyAsHumanUseCase } from "../../src/core/modules/conversations/application/use-cases/reply-as-human.use-case";
import type { ListConversationsUseCase } from "../../src/core/modules/conversations/application/use-cases/list-conversations.use-case";
import type { ListMessagesUseCase } from "../../src/core/modules/conversations/application/use-cases/list-messages.use-case";
import type { TakeControlUseCase } from "../../src/core/modules/conversations/application/use-cases/take-control.use-case";
import type { MarkConversationAsReadUseCase } from "../../src/core/modules/conversations/application/use-cases/mark-conversation-as-read.use-case";
import type { CaseRepositoryPort } from "../../src/core/modules/cases/application/ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../src/core/modules/conversations/application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../src/core/modules/conversations/application/ports/message.repository.port";
import type { WhatsAppSenderPort } from "../../src/core/modules/conversations/application/ports/whatsapp-sender.port";
import type { AuditRepositoryPort } from "../../src/core/modules/audit/application/ports/audit.repository.port";
import type { Logger } from "../../src/shared/logging/logger";

describe("LocalMediaStorageAdapter & /api/media persistent storage", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "isp-media-test-"));
    _clearMediaCacheForTesting();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persiste imagenes, audios y videos en disco local y los recupera tras limpiar cache en memoria (retencion indefinida)", async () => {
    const storage = new LocalMediaStorageAdapter({
      baseDir: tempDir,
      env: { ...env, ZERNIO_BASE_URL: "https://zernio.com/api/v1" },
    });

    const imageTarget = "https://zernio.com/api/v1/whatsapp/media/img-123";
    const audioTarget = "https://zernio.com/api/v1/whatsapp/media/aud-456.ogg";
    const videoTarget = "https://zernio.com/api/v1/whatsapp/media/vid-789.mp4";

    const imgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const audBuf = Buffer.from("OggS-fake-voice-note-content");
    const vidBuf = Buffer.from("00000018ftypmp42-fake-video-content");

    const savedImg = await storage.save(imageTarget, imgBuf, "image/jpeg", "comprobante.jpg");
    const savedAud = await storage.save(audioTarget, audBuf, "audio/ogg", "nota.ogg");
    const savedVid = await storage.save(videoTarget, vidBuf, "video/mp4", "router.mp4");

    expect(savedImg.filePath).toBeDefined();
    expect(savedImg.filePath?.endsWith(".jpg")).toBe(true);
    expect(savedAud.filePath?.endsWith(".ogg")).toBe(true);
    expect(savedVid.filePath?.endsWith(".mp4")).toBe(true);

    // Simular reinicio del servidor o paso de >24h vaciando la memoria RAM
    storage.clearMemoryCache();

    const diskImg = await storage.get(imageTarget);
    const diskAud = await storage.get(audioTarget);
    const diskVid = await storage.get(videoTarget);

    expect(diskImg).not.toBeNull();
    expect(diskImg?.buffer.equals(imgBuf)).toBe(true);
    expect(diskImg?.contentType).toBe("image/jpeg");

    expect(diskAud).not.toBeNull();
    expect(diskAud?.buffer.equals(audBuf)).toBe(true);
    expect(diskAud?.contentType).toBe("audio/ogg");

    expect(diskVid).not.toBeNull();
    expect(diskVid?.buffer.equals(vidBuf)).toBe(true);
    expect(diskVid?.contentType).toBe("video/mp4");
  });

  it("ensureStored descarga de Zernio una sola vez y sigue sirviendo desde disco aunque el enlace remoto expire (404)", async () => {
    const storage = new LocalMediaStorageAdapter({
      baseDir: tempDir,
      env: {
        ...env,
        ZERNIO_API_KEY: "test_zernio_key",
        ZERNIO_BASE_URL: "https://zernio.com/api/v1",
      },
    });

    const mediaUrl = "https://zernio.com/api/v1/whatsapp/media/expiring-audio-001";
    const audioPayload = Buffer.from("OggS-persistent-audio-payload");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(audioPayload, {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      }),
    );

    // 1. Descarga proactiva al recibir el mensaje en el webhook
    const first = await storage.ensureStored(mediaUrl, { mimeType: "audio/ogg" });
    expect(first).not.toBeNull();
    expect(first?.buffer.equals(audioPayload)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 2. Simular que pasaron 48 horas: se vacía la RAM y Zernio ahora responde 404 (enlace expirado)
    storage.clearMemoryCache();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "Media expired" }), { status: 404 }),
    );

    const after24h = await storage.ensureStored(mediaUrl);
    expect(after24h).not.toBeNull();
    expect(after24h?.buffer.equals(audioPayload)).toBe(true);
    expect(after24h?.contentType).toBe("audio/ogg");
    // No debió volver a llamar a fetch porque ya estaba en disco
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sirve video y audio desde disco en /api/media con soporte de HTTP Range (206) cuando la URL original ya caduco", async () => {
    const storage = new LocalMediaStorageAdapter({
      baseDir: tempDir,
      env: {
        ...env,
        ZERNIO_API_KEY: "test_zernio_key",
        ZERNIO_BASE_URL: "https://zernio.com/api/v1",
      },
    });

    const videoUrl = "https://zernio.com/api/v1/whatsapp/media/video-evidencia.mp4";
    const videoBytes = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    await storage.save(videoUrl, videoBytes, "video/mp4", "video-evidencia.mp4");
    storage.clearMemoryCache();

    // Si intentara ir a la red, fallaría con 410 Gone
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Gone", { status: 410 }),
    );

    const app = express();
    app.use(
      createConversationsRouter({
        listConversations: { execute: vi.fn() } as unknown as ListConversationsUseCase,
        listMessages: { execute: vi.fn() } as unknown as ListMessagesUseCase,
        replyAsHuman: { execute: vi.fn() } as unknown as ReplyAsHumanUseCase,
        takeControl: { execute: vi.fn() } as unknown as TakeControlUseCase,
        markAsRead: { execute: vi.fn() } as unknown as MarkConversationAsReadUseCase,
        caseRepo: {} as unknown as CaseRepositoryPort,
        mediaStorage: storage,
      }),
    );

    // Petición parcial (Range) como la que hace el reproductor <video> o <audio> del navegador
    const rangeRes = await request(app)
      .get(`/api/media?url=${encodeURIComponent(videoUrl)}`)
      .set("Range", "bytes=0-9");

    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers["content-type"]).toContain("video/mp4");
    expect(rangeRes.headers["content-range"]).toBe(`bytes 0-9/${videoBytes.length}`);
    expect(Buffer.from(rangeRes.body).toString("utf-8")).toBe("0123456789");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("permite al agente enviar imagenes, documentos, videos y audios desde la bandeja (multipart y base64) y los persiste en disco local", async () => {
    const storage = new LocalMediaStorageAdapter({
      baseDir: tempDir,
      env: { ...env, ZERNIO_BASE_URL: "https://zernio.com/api/v1" },
    });

    const sendMediaMock = vi.fn().mockImplementation(async (input) => ({
      externalId: `wa-ext-${input.type}`,
      remoteMediaId: `https://media.zernio.com/temp/${input.filename || input.type}`,
    }));

    const insertOutboundMock = vi.fn().mockImplementation(async (input) => ({
      id: `msg-${input.type}`,
      conversationId: input.conversationId,
      caseId: input.caseId ?? null,
      direction: "outbound",
      author: "agent",
      agentId: input.agentId ?? null,
      externalId: input.externalId ?? null,
      body: input.body,
      type: input.type ?? "text",
      mediaId: input.mediaId ?? null,
      mimeType: input.mimeType ?? null,
      caption: input.caption ?? null,
      filename: input.filename ?? null,
      status: "sent",
      errorMessage: null,
      createdAt: new Date(),
    }));

    const setAutomationEnabledMock = vi.fn().mockResolvedValue(undefined);
    const appendEventMock = vi.fn().mockResolvedValue(undefined);

    const replyAsHuman = new ReplyAsHumanUseCase({
      conversationRepo: {
        findById: vi.fn().mockResolvedValue({
          id: "conv-1",
          waPhone: "593999111222",
          activeCaseId: "case-1",
          status: "open",
        }),
        touchLastActivity: vi.fn().mockResolvedValue(undefined),
      } as unknown as ConversationRepositoryPort,
      messageRepo: {
        insertOutbound: insertOutboundMock,
      } as unknown as MessageRepositoryPort,
      whatsappSender: {
        sendText: vi.fn(),
        sendMedia: sendMediaMock,
        sendTemplate: vi.fn(),
      } as unknown as WhatsAppSenderPort,
      auditRepo: {
        record: vi.fn().mockResolvedValue(undefined),
      } as unknown as AuditRepositoryPort,
      caseRepo: {
        getAutomationState: vi.fn().mockResolvedValue({ enabled: true, disabledReason: null }),
        setAutomationEnabled: setAutomationEnabledMock,
        appendEvent: appendEventMock,
      } as unknown as CaseRepositoryPort,
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as unknown as Logger,
      mediaStorage: storage,
    });

    const app = express();
    app.use(express.json({ limit: "20mb" }));
    // Inyectar agente autenticado en req.agent
    app.use((req, _res, next) => {
      req.agent = {
        id: "agent-001",
        name: "Agente Soporte",
        email: "soporte@isp.com",
        role: "agent",
        active: true,
        autoAssignEnabled: false,
        mustChangePassword: false,
        primaryDepartmentId: "dept-1",
        createdAt: new Date(),
      };
      next();
    });
    app.use(
      createConversationsRouter({
        listConversations: { execute: vi.fn() } as unknown as ListConversationsUseCase,
        listMessages: { execute: vi.fn() } as unknown as ListMessagesUseCase,
        replyAsHuman,
        takeControl: { execute: vi.fn() } as unknown as TakeControlUseCase,
        markAsRead: { execute: vi.fn() } as unknown as MarkConversationAsReadUseCase,
        caseRepo: {} as unknown as CaseRepositoryPort,
        mediaStorage: storage,
      }),
    );

    // 1. Imagen por multipart/form-data en /api/conversations/:id/reply
    const imgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const imgRes = await request(app)
      .post("/api/conversations/conv-1/reply")
      .field("caption", "Estado de su antena")
      .attach("file", imgBytes, { filename: "antena.jpg", contentType: "image/jpeg" });

    expect(imgRes.status).toBe(201);
    expect(imgRes.body.data.type).toBe("image");
    expect(imgRes.body.data.caption).toBe("Estado de su antena");
    expect(imgRes.body.data.filename).toBe("antena.jpg");
    expect(imgRes.body.data.mediaId).toBe("https://media.zernio.com/temp/antena.jpg");
    expect(setAutomationEnabledMock).toHaveBeenCalledWith("case-1", false, {
      reason: "HUMAN_REPLY",
      changedBy: "agent-001",
    });

    // 2. Documento PDF por multipart/form-data en /api/conversations/:id/media
    const pdfBytes = Buffer.from("%PDF-1.4-factura-mensual");
    const docRes = await request(app)
      .post("/api/conversations/conv-1/media")
      .field("body", "Adjunto su factura del mes")
      .attach("file", pdfBytes, { filename: "factura_octubre.pdf", contentType: "application/pdf" });

    expect(docRes.status).toBe(201);
    expect(docRes.body.data.type).toBe("document");
    expect(docRes.body.data.filename).toBe("factura_octubre.pdf");
    expect(docRes.body.data.mimeType).toBe("application/pdf");

    // 3. Video MP4 por multipart/form-data en /api/conversations/:id/attachments
    const vidBytes = Buffer.from("00000018ftypmp42-tutorial-reinicio");
    const vidRes = await request(app)
      .post("/api/conversations/conv-1/attachments")
      .field("caption", "Tutorial de reinicio de ONT")
      .attach("file", vidBytes, { filename: "reinicio.mp4", contentType: "video/mp4" });

    expect(vidRes.status).toBe(201);
    expect(vidRes.body.data.type).toBe("video");
    expect(vidRes.body.data.filename).toBe("reinicio.mp4");

    // 4. Audio de voz en JSON base64 en /api/conversations/:id/reply
    const audBytes = Buffer.from("OggS-nota-de-voz-agente");
    const audRes = await request(app)
      .post("/api/conversations/conv-1/reply")
      .send({
        type: "audio",
        filename: "respuesta-voz.ogg",
        mimeType: "audio/ogg",
        voiceNote: true,
        dataUrl: `data:audio/ogg;base64,${audBytes.toString("base64")}`,
      });

    expect(audRes.status).toBe(201);
    expect(audRes.body.data.type).toBe("audio");
    expect(audRes.body.data.body).toBe("[audio]");
    expect(sendMediaMock).toHaveBeenCalledTimes(4);

    // Verificar que los archivos salientes quedaron persistidos en disco local y se sirven desde /api/media
    storage.clearMemoryCache();
    const storedPdf = await storage.get("https://media.zernio.com/temp/factura_octubre.pdf");
    expect(storedPdf).not.toBeNull();
    expect(storedPdf?.buffer.equals(pdfBytes)).toBe(true);
  });
});

