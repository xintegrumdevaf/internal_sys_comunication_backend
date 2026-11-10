/**
 * Servicio de deduplicación y enfriamiento (cooldown) de alertas para evitar
 * inundar el grupo de Telegram con notificaciones repetidas sobre la misma incidencia.
 */
export class AlertCooldownCacheService {
  private cache = new Map<string, number>();

  constructor(private readonly defaultCooldownMs: number = 30 * 60 * 1000) {}

  /**
   * Verifica si una alerta puede ser disparada. Si no está en cooldown,
   * la registra y retorna true; si ya fue emitida recientemente, retorna false.
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
   * Limpia manualmente el cooldown de una clave específica.
   */
  clear(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Limpia todo el historial de cooldowns (útil en tests o reinicios).
   */
  clearAll(): void {
    this.cache.clear();
  }
}

