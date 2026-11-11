import type { Logger } from "../../../../../shared/logging/logger";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import type { SendTelegramDigestUseCase } from "../use-cases/send-telegram-digest.use-case";

export interface TelegramDigestSchedulerDeps {
  sendDigestUseCase: SendTelegramDigestUseCase;
  getSettings: () => Promise<TelegramSettings>;
  logger: Logger;
  intervalMs?: number;
  graceMinutes?: number;
  /**
   * Lock distribuido/persistente opcional (ej. Redis SET NX EX) para evitar duplicados
   * entre reinicios o múltiples réplicas cuando el slot ya fue ejecutado.
   */
  acquireSlotLock?: (slotKey: string, ttlSeconds: number) => Promise<boolean>;
  releaseSlotLock?: (slotKey: string) => Promise<void>;
}

/**
 * Planificador en segundo plano que vigila las horas configuradas (digestHours)
 * y despacha el pulso operativo ejecutivo a Telegram de forma automática y puntual.
 */
export class TelegramDigestSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private isRunningCheck = false;
  private readonly executedSlots = new Set<string>();
  private readonly intervalMs: number;
  private readonly graceMinutes: number;

  constructor(private readonly deps: TelegramDigestSchedulerDeps) {
    // Evalúa cada 15 segundos con ventana de tolerancia de 3 min ante reinicios o latencia
    this.intervalMs = deps.intervalMs ?? 15_000;
    this.graceMinutes = deps.graceMinutes ?? 3;
  }

  start(): void {
    if (this.timer) return;

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.checkScheduledSlot().catch((err) => {
        this.deps.logger.warn({ err }, "error en verificación inicial de digest de Telegram");
      });
    }, 1_000);

    this.timer = setInterval(() => {
      void this.checkScheduledSlot().catch((err) => {
        this.deps.logger.warn({ err }, "error al verificar horario de digest en Telegram");
      });
    }, this.intervalMs);

    this.deps.logger.info(
      { intervalMs: this.intervalMs, graceMinutes: this.graceMinutes },
      "planificador de digests de Telegram iniciado",
    );
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.deps.logger.info("planificador de digests de Telegram detenido");
    }
  }

  async checkScheduledSlot(): Promise<boolean> {
    if (this.isRunningCheck) return false;
    this.isRunningCheck = true;

    try {
      const settings = await this.deps.getSettings();
      if (!settings.enabled || !settings.digestsEnabled || !settings.defaultChatId) {
        return false;
      }

      const configuredHours = settings.digestHours || [];
      if (configuredHours.length === 0) return false;

      const timeZone = settings.timeZone || "America/Guayaquil";
      const now = new Date();
      const clock = getLocalClockParts(now, timeZone);

      let dispatched = false;

      for (const rawHour of configuredHours) {
        const parsed = parseHourSlot(rawHour);
        if (!parsed) continue;

        const matchDateKey = matchSlotWithGrace(clock, parsed.totalMinutes, this.graceMinutes);
        if (!matchDateKey) continue;

        const slotKey = `${matchDateKey}_${parsed.normalized}`;
        if (this.executedSlots.has(slotKey)) continue;

        if (this.deps.acquireSlotLock) {
          const acquired = await this.deps.acquireSlotLock(slotKey, 24 * 3600).catch(() => true);
          if (!acquired) {
            this.executedSlots.add(slotKey);
            continue;
          }
        }

        this.executedSlots.add(slotKey);
        this.deps.logger.info(
          { slotKey, timeZone, currentTime: clock.hhmm, scheduledHour: parsed.normalized },
          "disparando digest programado de Telegram para horario configurado",
        );

        try {
          await this.deps.sendDigestUseCase.execute({ timeLabel: parsed.normalized });
          dispatched = true;
        } catch (err) {
          this.executedSlots.delete(slotKey);
          if (this.deps.releaseSlotLock) {
            await this.deps.releaseSlotLock(slotKey).catch(() => undefined);
          }
          throw err;
        }

        if (this.executedSlots.size > 50) {
          const oldest = Array.from(this.executedSlots).slice(0, 20);
          for (const k of oldest) this.executedSlots.delete(k);
        }
      }

      return dispatched;
    } finally {
      this.isRunningCheck = false;
    }
  }

  async sendNow(timeLabel?: string): Promise<boolean> {
    const result = await this.deps.sendDigestUseCase.execute({
      forced: true,
      timeLabel: timeLabel || "Manual",
    });
    return Boolean(result?.ok);
  }
}

interface ParsedHourSlot {
  hour: number;
  minute: number;
  totalMinutes: number;
  normalized: string;
}

function parseHourSlot(raw: string): ParsedHourSlot | null {
  const match = raw.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return {
    hour,
    minute,
    totalMinutes: hour * 60 + minute,
    normalized: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

interface LocalClockParts {
  dateKey: string;
  prevDateKey: string;
  hhmm: string;
  totalMinutes: number;
}

function getLocalClockParts(now: Date, timeZone: string): LocalClockParts {
  const formatDateKey = (d: Date) =>
    d.toLocaleDateString("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const hour = Number(timeParts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(timeParts.find((p) => p.type === "minute")?.value ?? 0);
  const prevDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  return {
    dateKey: formatDateKey(now),
    prevDateKey: formatDateKey(prevDay),
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    totalMinutes: hour * 60 + minute,
  };
}

function matchSlotWithGrace(clock: LocalClockParts, slotMinutes: number, graceMinutes: number): string | null {
  const sameDayDiff = clock.totalMinutes - slotMinutes;
  if (sameDayDiff >= 0 && sameDayDiff <= graceMinutes) {
    return clock.dateKey;
  }

  // Tolerancia ante cruce de medianoche (ej. slot 23:58 evaluado a las 00:01)
  if (clock.totalMinutes < graceMinutes && slotMinutes >= 1440 - graceMinutes) {
    const wrappedDiff = clock.totalMinutes + 1440 - slotMinutes;
    if (wrappedDiff >= 0 && wrappedDiff <= graceMinutes) {
      return clock.prevDateKey;
    }
  }

  return null;
}
