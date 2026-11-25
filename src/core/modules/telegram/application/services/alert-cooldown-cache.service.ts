export interface PersistentAlertCooldownCallbacks {
  /**
   * Intenta adquirir un bloqueo de cooldown persistente (por ejemplo Redis `SET NX PX`).
   * Debe retornar `true` si la alerta puede dispararse, o `false` si sigue en cooldown.
   */
  tryAcquire: (key: string, cooldownMs: number) => Promise<boolean>;
  /**
   * Libera manualmente una clave de cooldown persistente.
   */
  release?: (key: string) => Promise<void>;
}

/**
 * Servicio de deduplicación y enfriamiento (cooldown) de alertas para evitar
 * inundar el grupo de Telegram con notificaciones repetidas sobre la misma incidencia,
 * con soporte de persistencia opcional en Redis para sobrevivir reinicios.
 */
export class AlertCooldownCacheService {
  private cache = new Map<string, number>();

  constructor(
    private readonly defaultCooldownMs: number = 30 * 60 * 1000,
    private readonly persistentStore?: PersistentAlertCooldownCallbacks,
  ) {}

  /**
   * Verifica si una alerta puede ser disparada usando caché en memoria.
   */
  shouldAlert(key: string, customCooldownMs?: number): boolean {
    const now = Date.now();
    const lastEmitted = this.cache.get(key);
    const cooldown = customCooldownMs ?? this.defaultCooldownMs;

    if (lastEmitted && now - lastEmitted < cooldown) {
      return false;
    }

    this.cache.set(key, now);
    return true;
  }

  /**
   * Verifica cooldown usando almacén persistente (Redis) si está configurado,
   * con respaldo en memoria local.
   */
  async shouldAlertAsync(key: string, customCooldownMs?: number): Promise<boolean> {
    if (!this.shouldAlert(key, customCooldownMs)) {
      return false;
    }

    if (this.persistentStore) {
      try {
        const cooldown = Math.max(1000, customCooldownMs ?? this.defaultCooldownMs);
        return await this.persistentStore.tryAcquire(key, cooldown);
      } catch {
        // Fallback silencioso al estado en memoria ya registrado arriba
      }
    }

    return true;
  }

  /**
   * Limpia manualmente el cooldown de una clave específica en memoria.
   */
  clear(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Limpia manualmente el cooldown en memoria y en el almacén persistente.
   */
  async clearAsync(key: string): Promise<void> {
    this.cache.delete(key);
    if (this.persistentStore?.release) {
      try {
        await this.persistentStore.release(key);
      } catch {
        // Ignorar fallo de limpieza remota para no bloquear flujos de negocio
      }
    }
  }

  /**
   * Limpia todo el historial de cooldowns en memoria (útil en tests).
   */
  clearAll(): void {
    this.cache.clear();
  }
}
