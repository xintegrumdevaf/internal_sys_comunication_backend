import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramDigestSchedulerService } from "../../src/core/modules/telegram/application/services/telegram-digest-scheduler.service";
import type { TelegramSettings } from "../../src/core/modules/telegram/domain/telegram-config.entity";
import { silentLogger } from "../support/silent-logger";

describe("TelegramDigestSchedulerService", () => {
  const baseSettings: TelegramSettings = {
    enabled: true,
    botToken: "123:ABC",
    defaultChatId: "-100111",
    topicsEnabled: false,
    topics: [],
    slaTopicId: 10,
    infraTopicId: 20,
    digestsTopicId: 30,
    digestsEnabled: true,
    digestHours: ["09:00", "14:00", "19:00"],
    timeZone: "America/Guayaquil",
    alertRules: [],
    slaThresholdMinutes: 15,
    infraAlertMinCases: 3,
    queueSaturationThreshold: 10,
    webhookSecret: "",
    commandsEnabled: true,
    aiCopilotEnabled: false,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("inicia y detiene el temporizador correctamente", () => {
    const fakeSendUseCase = { execute: vi.fn() } as any;
    const scheduler = new TelegramDigestSchedulerService({
      sendDigestUseCase: fakeSendUseCase,
      getSettings: async () => baseSettings,
      logger: silentLogger,
      intervalMs: 10_000,
    });

    scheduler.start();
    // Iniciar de nuevo no duplica el timer
    scheduler.start();

    scheduler.stop();
    // Detener dos veces no arroja error
    scheduler.stop();
  });

  it("omite la ejecución si digestsEnabled está en false", async () => {
    const fakeSendUseCase = { execute: vi.fn() } as any;
    const scheduler = new TelegramDigestSchedulerService({
      sendDigestUseCase: fakeSendUseCase,
      getSettings: async () => ({ ...baseSettings, digestsEnabled: false }),
      logger: silentLogger,
    });

    const triggered = await scheduler.checkScheduledSlot();
    expect(triggered).toBe(false);
    expect(fakeSendUseCase.execute).not.toHaveBeenCalled();
  });

  it("omite la ejecución si la hora actual no coincide con ninguna configurada", async () => {
    // Fijar hora a las 11:30 en America/Guayaquil (UTC-5 -> 16:30 UTC)
    vi.setSystemTime(new Date("2026-11-10T16:30:00Z"));

    const fakeSendUseCase = { execute: vi.fn() } as any;
    const scheduler = new TelegramDigestSchedulerService({
      sendDigestUseCase: fakeSendUseCase,
      getSettings: async () => ({ ...baseSettings, digestHours: ["09:00", "14:00"] }),
      logger: silentLogger,
    });

    const triggered = await scheduler.checkScheduledSlot();
    expect(triggered).toBe(false);
    expect(fakeSendUseCase.execute).not.toHaveBeenCalled();
  });

  it("dispara el digest en la hora exacta y evita duplicados en el mismo minuto", async () => {
    // 09:00 AM en America/Guayaquil (UTC-5) equivale a 14:00:00 UTC
    vi.setSystemTime(new Date("2026-11-10T14:00:15Z"));

    const fakeSendUseCase = {
      execute: vi.fn().mockResolvedValue({ ok: true, messageId: 888 }),
    } as any;

    const scheduler = new TelegramDigestSchedulerService({
      sendDigestUseCase: fakeSendUseCase,
      getSettings: async () => baseSettings,
      logger: silentLogger,
    });

    // Primer check en la ventana del minuto 09:00
    const firstCheck = await scheduler.checkScheduledSlot();
    expect(firstCheck).toBe(true);
    expect(fakeSendUseCase.execute).toHaveBeenCalledTimes(1);
    expect(fakeSendUseCase.execute).toHaveBeenCalledWith({ timeLabel: "09:00" });

    // Segundo check en el mismo minuto (por ejemplo, a los 30 seg)
    vi.advanceTimersByTime(30_000);
    const secondCheck = await scheduler.checkScheduledSlot();
    expect(secondCheck).toBe(false);
    expect(fakeSendUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it("sendNow() ejecuta el digest de forma forzada con etiqueta manual", async () => {
    const fakeSendUseCase = {
      execute: vi.fn().mockResolvedValue({ ok: true, messageId: 777 }),
    } as any;

    const scheduler = new TelegramDigestSchedulerService({
      sendDigestUseCase: fakeSendUseCase,
      getSettings: async () => baseSettings,
      logger: silentLogger,
    });

    const success = await scheduler.sendNow();
    expect(success).toBe(true);
    expect(fakeSendUseCase.execute).toHaveBeenCalledWith({ forced: true, timeLabel: "Manual" });
  });

  it("dispara el digest a las 12:00 y recupera dentro de la ventana de tolerancia tras un reinicio", async () => {
    // 12:02 PM en America/Guayaquil (UTC-5) equivale a 17:02:10 UTC (2 min después de las 12:00)
    vi.setSystemTime(new Date("2026-11-11T17:02:10Z"));

    const fakeSendUseCase = {
      execute: vi.fn().mockResolvedValue({ ok: true, messageId: 901 }),
    } as any;

    const locks = new Set<string>();
    const scheduler = new TelegramDigestSchedulerService({
      sendDigestUseCase: fakeSendUseCase,
      getSettings: async () => ({ ...baseSettings, digestHours: ["12:00"] }),
      logger: silentLogger,
      acquireSlotLock: async (key) => {
        if (locks.has(key)) return false;
        locks.add(key);
        return true;
      },
    });

    // Dispara recuperando el slot de las 12:00 dentro de la ventana de 3 min
    const caughtUp = await scheduler.checkScheduledSlot();
    expect(caughtUp).toBe(true);
    expect(fakeSendUseCase.execute).toHaveBeenCalledTimes(1);
    expect(fakeSendUseCase.execute).toHaveBeenCalledWith({ timeLabel: "12:00" });

    // Si una segunda instancia (o tras otro reinicio dentro del minuto 12:03) evalúa, el lock persistente evita duplicar
    const secondInstance = new TelegramDigestSchedulerService({
      sendDigestUseCase: fakeSendUseCase,
      getSettings: async () => ({ ...baseSettings, digestHours: ["12:00"] }),
      logger: silentLogger,
      acquireSlotLock: async (key) => {
        if (locks.has(key)) return false;
        locks.add(key);
        return true;
      },
    });
    vi.setSystemTime(new Date("2026-11-11T17:03:00Z"));
    const duplicate = await secondInstance.checkScheduledSlot();
    expect(duplicate).toBe(false);
    expect(fakeSendUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it("libera el lock si el envío del digest falla para permitir reintento en el siguiente ciclo", async () => {
    vi.setSystemTime(new Date("2026-11-11T17:00:10Z")); // 12:00 Guayaquil

    const fakeSendUseCase = {
      execute: vi
        .fn()
        .mockRejectedValueOnce(new Error("Telegram timeout"))
        .mockResolvedValueOnce({ ok: true, messageId: 902 }),
    } as any;

    const locks = new Set<string>();
    const scheduler = new TelegramDigestSchedulerService({
      sendDigestUseCase: fakeSendUseCase,
      getSettings: async () => ({ ...baseSettings, digestHours: ["12:00"] }),
      logger: silentLogger,
      acquireSlotLock: async (key) => {
        if (locks.has(key)) return false;
        locks.add(key);
        return true;
      },
      releaseSlotLock: async (key) => {
        locks.delete(key);
      },
    });

    await expect(scheduler.checkScheduledSlot()).rejects.toThrow("Telegram timeout");
    expect(locks.size).toBe(0);

    // En el siguiente tick 15s después reintenta y logra enviarlo
    vi.advanceTimersByTime(15_000);
    const retried = await scheduler.checkScheduledSlot();
    expect(retried).toBe(true);
    expect(fakeSendUseCase.execute).toHaveBeenCalledTimes(2);
  });
});

