import { describe, expect, it, vi } from "vitest";
import { TelegramAlertWatcherService } from "../../src/core/modules/telegram/application/services/telegram-alert-watcher.service";
import type { CheckSystemAlertsUseCase } from "../../src/core/modules/telegram/application/use-cases/check-system-alerts.use-case";
import { silentLogger } from "../support/silent-logger";

describe("TelegramAlertWatcherService", () => {
  it("inicia, detiene y ejecuta checkNow correctamente", async () => {
    let callCount = 0;
    const fakeUseCase = {
      execute: vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          dispatchedCount: 1,
          slaBreachesCount: 1,
          queueDelaysCount: 0,
          infraAlertsCount: 0,
          alerts: [],
        };
      }),
    } as unknown as CheckSystemAlertsUseCase;

    const watcher = new TelegramAlertWatcherService({
      checkAlertsUseCase: fakeUseCase,
      logger: silentLogger,
      intervalMs: 100,
    });

    const dispatched = await watcher.checkNow();
    expect(dispatched).toBe(1);
    expect(callCount).toBe(1);

    watcher.start();
    // Iniciar de nuevo no duplica timers
    watcher.start();

    // Esperar a que el timer se dispare
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBeGreaterThanOrEqual(2);

    watcher.stop();
    const countAfterStop = callCount;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(countAfterStop);
  });
});
