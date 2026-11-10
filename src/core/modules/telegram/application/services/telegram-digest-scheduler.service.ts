import type { Logger } from "../../../../../shared/logging/logger";
import type { SendTelegramDigestUseCase } from "../use-cases/send-telegram-digest.use-case";
import type { TelegramSettings } from "../../domain/telegram-config.entity";

export interface TelegramDigestSchedulerDeps {
  sendDigestUseCase: SendTelegramDigestUseCase;
  getSettings: () => Promise<TelegramSettings>;
  logger: Logger;
  intervalMs?: number;
}

/**
 * Planificador en segundo plano que vigila las horas configuradas (digestHours)
 * y despacha el pulso operativo ejecutivo a Telegram de forma automática y puntual.
 */
export class TelegramDigestSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private isRunningCheck = false;
  private readonly executedSlots = new Set<string>();
  private readonly intervalMs: number;

  constructor(private readonly deps: TelegramDigestSchedulerDeps) {
    // Por defecto evalúa cada 30 segundos para no perder el minuto exacto
    this.intervalMs = deps.intervalMs ?? 30_000;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.checkScheduledSlot().catch((err) => {
        this.deps.logger.warn({ err }, "error al verificar horario de digest en Telegram");
      });
    }, this.intervalMs);

    this.deps.logger.info("planificador de digests de Telegram iniciado");
  }

  stop(): void {
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

      const currentTime = now.toLocaleTimeString("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }); // Formato HH:mm

      const currentDate = now.toLocaleDateString("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }); // Formato YYYY-MM-DD

      const slotKey = `${currentDate}_${currentTime}`;

      // Si la hora actual coincide con una configurada y no se ha emitido hoy
      if (configuredHours.includes(currentTime) && !this.executedSlots.has(slotKey)) {
        this.executedSlots.add(slotKey);
        this.deps.logger.info(
          { slotKey, timeZone, currentTime },
          "disparando digest programado de Telegram para horario configurado",
        );

        await this.deps.sendDigestUseCase.execute({ timeLabel: currentTime });

        // Limpiar slots viejos para no acumular memoria (conserva solo los últimos 50)
        if (this.executedSlots.size > 50) {
          const oldest = Array.from(this.executedSlots).slice(0, 20);
          for (const k of oldest) this.executedSlots.delete(k);
        }

        return true;
      }

      return false;
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
