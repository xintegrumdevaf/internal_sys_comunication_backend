import type { Logger } from "../../../../../shared/logging/logger";
import type { CheckSystemAlertsUseCase } from "../use-cases/check-system-alerts.use-case";

export interface TelegramAlertWatcherDeps {
  checkAlertsUseCase: CheckSystemAlertsUseCase;
  logger: Logger;
  intervalMs?: number;
}

/**
 * Centinela en segundo plano que sondea de forma periódica brechas de SLA
 * y caídas de infraestructura para despachar alertas proactivas a Telegram.
 */
export class TelegramAlertWatcherService {
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private readonly intervalMs: number;

  constructor(private readonly deps: TelegramAlertWatcherDeps) {
    // Por defecto sondea cada 2 minutos
    this.intervalMs = deps.intervalMs ?? 2 * 60 * 1000;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.checkNow().catch((err) => {
        this.deps.logger.warn({ err }, "error no controlado en sondeo de alertas de Telegram");
      });
    }, this.intervalMs);

    this.deps.logger.info(
      { intervalSeconds: Math.round(this.intervalMs / 1000) },
      "centinela de alertas de Telegram iniciado exitosamente",
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.deps.logger.info("centinela de alertas de Telegram detenido");
    }
  }

  async checkNow(): Promise<number> {
    if (this.isChecking) {
      this.deps.logger.debug("sondeo previo de alertas de Telegram aún en curso; omitiendo ciclo");
      return 0;
    }

    this.isChecking = true;
    try {
      const result = await this.deps.checkAlertsUseCase.execute();
      return result.dispatchedCount;
    } finally {
      this.isChecking = false;
    }
  }
}
