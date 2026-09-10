import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZernioHistoryGatewayHttp } from "../../src/core/modules/conversations/infrastructure/zernio/zernio-history.gateway.http";
import { ZernioHistorySyncWorker, ZERNIO_HISTORY_QUEUE_KEY, ZERNIO_HISTORY_STATUS_KEY } from "../../src/core/modules/conversations/infrastructure/queue/zernio-history-sync.worker";
import { StartZernioHistorySyncUseCase } from "../../src/core/modules/conversations/application/use-cases/start-zernio-history-sync.use-case";
import { GetZernioHistorySyncStatusUseCase } from "../../src/core/modules/conversations/application/use-cases/get-zernio-history-sync-status.use-case";
import { ConversationRepositoryFake, MessageRepositoryFake } from "../support/fakes";
import type { ZernioHistoryPort } from "../../src/core/modules/conversations/application/ports/zernio-history.port";
import type { Env } from "../../src/shared/config/env";
import type { Logger } from "../../src/shared/logging/logger";

const fakeEnv = {
  ZERNIO_API_KEY: "test-zernio-key",
  ZERNIO_ACCOUNT_ID: "6a9ec34a77555aae01ec0fde",
  ZERNIO_BASE_URL: "https://zernio.com/api/v1",
} as Env;

const fakeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => fakeLogger,
} as unknown as Logger;

class FakeRedis {
  private store = new Map<string, string>();
  private lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    const hadStore = this.store.delete(key);
    const hadList = this.lists.delete(key);
    return hadStore || hadList ? 1 : 0;
  }

  async rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.lists.get(key) ?? [];
    const item = list.shift() ?? null;
    return item;
  }

  async llen(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length;
  }
}

describe("Zernio Historical Sync Architecture", () => {
  let conversationRepo: ConversationRepositoryFake;
  let messageRepo: MessageRepositoryFake;
  let fakeRedis: FakeRedis;

  beforeEach(() => {
    conversationRepo = new ConversationRepositoryFake();
    messageRepo = new MessageRepositoryFake();
    fakeRedis = new FakeRedis();
    vi.restoreAllMocks();
  });

  describe("ZernioHistoryGatewayHttp", () => {
    it("obtiene lista de conversaciones resolviendo paginacion de Zernio", async () => {
      const gateway = new ZernioHistoryGatewayHttp(fakeEnv, fakeLogger);

      const mockFetch = vi
        .fn()
        // Primera página
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: "conv-1",
                participantId: "+593999183597",
                participantName: "Angel Fajardo",
                lastMessage: "Hola",
                updatedTime: "2026-09-01T10:00:00.000Z",
                unreadCount: 0,
              },
            ],
            pagination: { hasMore: true, nextCursor: "cursor-page-2" },
          }),
        })
        // Segunda página
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: "conv-2",
                participantId: "593993546974",
                participantName: "Cliente 2",
                lastMessage: "Buenas tardes",
                updatedTime: "2026-08-15T12:00:00.000Z",
                unreadCount: 2,
              },
            ],
            pagination: { hasMore: false },
          }),
        });

      global.fetch = mockFetch;

      const conversations = await gateway.fetchAllConversations();

      expect(conversations).toHaveLength(2);
      expect(conversations[0]?.id).toBe("conv-1");
      expect(conversations[0]?.participantId).toBe("593999183597");
      expect(conversations[1]?.id).toBe("conv-2");
      expect(conversations[1]?.participantId).toBe("593993546974");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("obtiene y mapea mensajes historicos ordenados cronologicamente", async () => {
      const gateway = new ZernioHistoryGatewayHttp(fakeEnv, fakeLogger);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          messages: [
            {
              id: "wamid.2",
              conversationId: "conv-1",
              message: "Respuesta posterior",
              direction: "outgoing",
              createdAt: "2026-09-01T10:05:00.000Z",
              metadata: { sentVia: "phone" },
            },
            {
              id: "wamid.1",
              conversationId: "conv-1",
              message: "Mensaje inicial",
              direction: "incoming",
              createdAt: "2026-09-01T10:00:00.000Z",
            },
          ],
          pagination: { hasMore: false },
        }),
      });

      global.fetch = mockFetch;

      const messages = await gateway.fetchMessagesForConversation("conv-1");

      expect(messages).toHaveLength(2);
      // Debe haber sido ordenado ascendentemente
      expect(messages[0]?.id).toBe("wamid.1");
      expect(messages[0]?.direction).toBe("incoming");
      expect(messages[1]?.id).toBe("wamid.2");
      expect(messages[1]?.direction).toBe("outgoing");
      expect(messages[1]?.sentVia).toBe("phone");
    });
  });

  describe("StartZernioHistorySyncUseCase & GetZernioHistorySyncStatusUseCase", () => {
    it("encola conversaciones e inicializa progreso en Redis", async () => {
      const mockHistoryGateway: ZernioHistoryPort = {
        fetchAllConversations: vi.fn().mockResolvedValue([
          {
            id: "z-conv-1",
            participantId: "593999183597",
            participantName: "Angel",
            updatedTime: "2026-09-01T10:00:00.000Z",
          },
        ]),
        fetchMessagesForConversation: vi.fn().mockResolvedValue([]),
      };

      const worker = new ZernioHistorySyncWorker(
        fakeRedis as any,
        mockHistoryGateway,
        conversationRepo,
        messageRepo,
        fakeLogger,
      );

      const startSync = new StartZernioHistorySyncUseCase(
        fakeRedis as any,
        mockHistoryGateway,
        worker,
        fakeLogger,
      );
      const getStatus = new GetZernioHistorySyncStatusUseCase(fakeRedis as any);

      const res = await startSync.execute();
      expect(res.alreadyRunning).toBe(false);
      expect(res.progress.totalConversations).toBe(1);
      expect(res.progress.status).toBe("IN_PROGRESS");

      // Verificar encolado en Redis
      const enqueuedCount = await fakeRedis.llen(ZERNIO_HISTORY_QUEUE_KEY);
      expect(enqueuedCount).toBe(1);

      // Verificar status use case
      const statusRes = await getStatus.execute();
      expect(statusRes.status).toBe("IN_PROGRESS");
      expect(statusRes.totalConversations).toBe(1);
      expect(statusRes.percentage).toBe(0);

      // Intentar iniciar nuevamente cuando ya está en progreso
      const secondStart = await startSync.execute();
      expect(secondStart.alreadyRunning).toBe(true);
      expect(secondStart.progress.status).toBe("IN_PROGRESS");
    });
  });

  describe("ZernioHistorySyncWorker", () => {
    it("procesa un trabajo de la cola, persiste mensajes con idempotencia y actualiza conversacion", async () => {
      const historicalMessages = [
        {
          id: "wamid.msg-1",
          conversationId: "z-conv-1",
          message: "Hola buenas",
          direction: "incoming" as const,
          senderId: "593999183597",
          createdAt: "2026-05-15T10:00:00.000Z",
        },
        {
          id: "wamid.msg-2",
          conversationId: "z-conv-1",
          message: "Hola en que le ayudo",
          direction: "outgoing" as const,
          senderId: "123456",
          sentVia: "phone",
          createdAt: "2026-05-15T10:02:00.000Z",
        },
      ];

      const mockHistoryGateway: ZernioHistoryPort = {
        fetchAllConversations: vi.fn().mockResolvedValue([]),
        fetchMessagesForConversation: vi.fn().mockResolvedValue(historicalMessages),
      };

      const worker = new ZernioHistorySyncWorker(
        fakeRedis as any,
        mockHistoryGateway,
        conversationRepo,
        messageRepo,
        fakeLogger,
      );

      // Preparar estado y cola
      const progress = {
        jobId: "test-job-123",
        status: "IN_PROGRESS" as const,
        totalConversations: 1,
        processedConversations: 0,
        failedConversations: 0,
        totalMessagesImported: 0,
        totalMessagesSkipped: 0,
        currentPhone: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        errors: [],
      };
      await fakeRedis.set(ZERNIO_HISTORY_STATUS_KEY, JSON.stringify(progress));
      await fakeRedis.rpush(
        ZERNIO_HISTORY_QUEUE_KEY,
        JSON.stringify({
          jobId: "test-job-123",
          zernioConversationId: "z-conv-1",
          participantId: "593999183597",
          participantName: "Angel Fajardo",
          attempt: 1,
        }),
      );

      // Procesar cola
      await worker.processQueue();

      // Verificar que la conversación fue creada en Postgres con nombre de perfil y cerrada (por ser antigua)
      const conv = await conversationRepo.findByWaPhone("593999183597");
      expect(conv).not.toBeNull();
      expect(conv?.waProfileName).toBe("Angel Fajardo");
      expect(conv?.status).toBe("closed");
      expect(conv?.lastActivityAt).toEqual(new Date("2026-05-15T10:02:00.000Z"));

      // Verificar que los mensajes fueron insertados con autor y dirección correctos
      const messages = await messageRepo.listByConversation(conv!.id);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.externalId).toBe("wamid.msg-1");
      expect(messages[0]?.author).toBe("customer");
      expect(messages[0]?.direction).toBe("inbound");
      expect(messages[1]?.externalId).toBe("wamid.msg-2");
      expect(messages[1]?.author).toBe("agent"); // Enviado desde el teléfono físico
      expect(messages[1]?.direction).toBe("outbound");

      // Verificar progreso final en Redis
      const finalProgress = await worker.getProgress();
      expect(finalProgress?.status).toBe("COMPLETED");
      expect(finalProgress?.processedConversations).toBe(1);
      expect(finalProgress?.totalMessagesImported).toBe(2);
      expect(finalProgress?.totalMessagesSkipped).toBe(0);
      expect(finalProgress?.finishedAt).not.toBeNull();
    });

    it("reintenta conversaciones que fallan y aisla errores sin corromper el progreso", async () => {
      const mockHistoryGateway: ZernioHistoryPort = {
        fetchAllConversations: vi.fn().mockResolvedValue([]),
        fetchMessagesForConversation: vi.fn().mockRejectedValue(new Error("Zernio timeout")),
      };

      const worker = new ZernioHistorySyncWorker(
        fakeRedis as any,
        mockHistoryGateway,
        conversationRepo,
        messageRepo,
        fakeLogger,
      );

      const progress = {
        jobId: "test-job-456",
        status: "IN_PROGRESS" as const,
        totalConversations: 1,
        processedConversations: 0,
        failedConversations: 0,
        totalMessagesImported: 0,
        totalMessagesSkipped: 0,
        currentPhone: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        errors: [],
      };
      await fakeRedis.set(ZERNIO_HISTORY_STATUS_KEY, JSON.stringify(progress));

      // Encolar con intento 1
      await fakeRedis.rpush(
        ZERNIO_HISTORY_QUEUE_KEY,
        JSON.stringify({
          jobId: "test-job-456",
          zernioConversationId: "z-conv-err",
          participantId: "593991112233",
          attempt: 1,
        }),
      );

      // Intento 1: falla y reencola con intento 2
      await worker.processQueue();
      const remaining1 = await fakeRedis.llen(ZERNIO_HISTORY_QUEUE_KEY);
      expect(remaining1).toBe(1);
      const jobInQueue = JSON.parse((await fakeRedis.lpop(ZERNIO_HISTORY_QUEUE_KEY))!);
      expect(jobInQueue.attempt).toBe(2);

      // Simular que el job ya va por el intento 3 y vuelve a fallar
      jobInQueue.attempt = 3;
      await fakeRedis.rpush(ZERNIO_HISTORY_QUEUE_KEY, JSON.stringify(jobInQueue));

      await worker.processQueue();

      // Debe haberse registrado el error definitivo y marcado como PARTIALLY_FAILED
      const finalProgress = await worker.getProgress();
      expect(finalProgress?.status).toBe("PARTIALLY_FAILED");
      expect(finalProgress?.failedConversations).toBe(1);
      expect(finalProgress?.errors).toHaveLength(1);
      expect(finalProgress?.errors[0]?.error).toContain("Zernio timeout");
    });
  });
});
