import { describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import { ConversationRepositoryFake, MessageRepositoryFake } from "../support/fakes";
import { CaseRepositoryFake } from "../cases/fakes";
import { emptyContextFor } from "../../src/core/modules/cases/domain/contexts/case-context";
import { ReceiveInboundEditUseCase } from "../../src/core/modules/conversations/application/use-cases/receive-inbound-edit.use-case";
import { silentLogger } from "../support/silent-logger";
import type { InboundBufferService } from "../../src/core/modules/ingestion/application/services/inbound-buffer.service";
import type { RealtimeBroadcaster } from "../../src/core/modules/realtime/application/realtime-broadcaster";

describe("ReceiveInboundEditUseCase", () => {
  const createFakeRedis = () => {
    return {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;
  };

  it("actualiza el mensaje original y guarda historial cuando la conversación y el mensaje existen", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const redisClient = createFakeRedis();

    const conv = conversationRepo.createOpen({ waPhone: "+593991234567" });
    const originalMsg = messageRepo.seedText(conv.id, "Texto original", {
      externalId: "wamid.ORIGINAL1",
    });

    const useCase = new ReceiveInboundEditUseCase({
      conversationRepo,
      messageRepo,
      redisClient,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      waPhone: "+593991234567",
      originalExternalId: "wamid.ORIGINAL1",
      newExternalId: "wamid.EDIT1",
      newBody: "Texto corregido",
    });

    expect(result.updated).toBe(true);
    expect(result.messageId).toBe(originalMsg.id);
    expect(result.conversationId).toBe(conv.id);

    const updated = await messageRepo.findByExternalId("wamid.ORIGINAL1");
    expect(updated?.body).toBe("Texto corregido");
    expect(updated?.editedAt).toBeDefined();
    expect(updated?.editHistory).toHaveLength(1);
    expect(updated?.editHistory?.[0]?.previousBody).toBe("Texto original");
  });

  it("descarta la edición si la conversación no existe", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const redisClient = createFakeRedis();

    const useCase = new ReceiveInboundEditUseCase({
      conversationRepo,
      messageRepo,
      redisClient,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      waPhone: "+593999999999",
      originalExternalId: "wamid.ORIGINAL1",
      newExternalId: "wamid.EDIT1",
      newBody: "Texto corregido",
    });

    expect(result.updated).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.conversationId).toBeNull();
  });

  it("descarta la edición si el mensaje original no existe en la base", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const redisClient = createFakeRedis();

    conversationRepo.createOpen({ waPhone: "+593991234567" });

    const useCase = new ReceiveInboundEditUseCase({
      conversationRepo,
      messageRepo,
      redisClient,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      waPhone: "+593991234567",
      originalExternalId: "wamid.NON_EXISTENT",
      newExternalId: "wamid.EDIT1",
      newBody: "Texto corregido",
    });

    expect(result.updated).toBe(false);
    expect(result.messageId).toBeNull();
  });

  it("resetea debounce via touch() si el mensaje estaba buffereado (pre-flush)", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const redisClient = createFakeRedis();

    const conv = conversationRepo.createOpen({ waPhone: "+593991234567" });
    messageRepo.seedText(conv.id, "Texto original", {
      externalId: "wamid.ORIGINAL1",
    });

    const inboundBuffer = {
      touch: vi.fn().mockReturnValue(true),
      push: vi.fn(),
    } as unknown as InboundBufferService;

    const useCase = new ReceiveInboundEditUseCase({
      conversationRepo,
      messageRepo,
      redisClient,
      inboundBuffer,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      waPhone: "+593991234567",
      originalExternalId: "wamid.ORIGINAL1",
      newExternalId: "wamid.EDIT1",
      newBody: "Texto corregido",
    });

    expect(result.updated).toBe(true);
    expect(result.wasBuffered).toBe(true);
    expect(inboundBuffer.touch).toHaveBeenCalledWith(conv.id);
  });

  it("re-encola en buffer si es edición post-flush y el caso está activo esperando al usuario", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const caseRepo = new CaseRepositoryFake();
    const redisClient = createFakeRedis();

    const conv = conversationRepo.createOpen({ waPhone: "+593991234567" });
    const msg = messageRepo.seedText(conv.id, "Texto original", {
      externalId: "wamid.ORIGINAL1",
    });

    const activeCase = await caseRepo.create({
      conversationId: conv.id,
      departmentId: null,
      workflowType: "SUPPORT_INTERNET",
      initialState: "WAITING_INPUT",
      context: emptyContextFor("SUPPORT_INTERNET"),
      expiresAt: null,
    });
    activeCase.case.status = "WAITING_USER";
    conv.activeCaseId = activeCase.case.id;

    const inboundBuffer = {
      touch: vi.fn().mockReturnValue(false),
      push: vi.fn().mockResolvedValue(undefined),
    } as unknown as InboundBufferService;

    const useCase = new ReceiveInboundEditUseCase({
      conversationRepo,
      messageRepo,
      redisClient,
      inboundBuffer,
      caseRepo,
      logger: silentLogger,
    });

    const result = await useCase.execute({
      waPhone: "+593991234567",
      originalExternalId: "wamid.ORIGINAL1",
      newExternalId: "wamid.EDIT1",
      newBody: "Texto corregido post-flush",
    });

    expect(result.updated).toBe(true);
    expect(result.wasBuffered).toBe(false);
    expect(inboundBuffer.push).toHaveBeenCalledWith(conv.id, msg.id);
  });

  it("emite evento realtime MESSAGE_EDITED al broadcaster", async () => {
    const conversationRepo = new ConversationRepositoryFake();
    const messageRepo = new MessageRepositoryFake();
    const redisClient = createFakeRedis();

    const conv = conversationRepo.createOpen({ waPhone: "+593991234567" });
    const msg = messageRepo.seedText(conv.id, "Texto original", {
      externalId: "wamid.ORIGINAL1",
    });

    const broadcaster = {
      publish: vi.fn(),
    } as unknown as RealtimeBroadcaster;

    const useCase = new ReceiveInboundEditUseCase({
      conversationRepo,
      messageRepo,
      redisClient,
      broadcaster,
      logger: silentLogger,
    });

    await useCase.execute({
      waPhone: "+593991234567",
      originalExternalId: "wamid.ORIGINAL1",
      newExternalId: "wamid.EDIT1",
      newBody: "Texto corregido",
    });

    expect(broadcaster.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MESSAGE_EDITED",
        conversationId: conv.id,
        messageId: msg.id,
        newBody: "Texto corregido",
      }),
    );
  });
});
