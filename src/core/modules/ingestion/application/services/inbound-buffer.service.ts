import type Redis from "ioredis";
import type { Logger } from "../../../../../shared/logging/logger";

export type FlushHandler = (conversationId: string, messageIds: string[]) => Promise<void>;

/**
 * `redis.call('LRANGE', ...)` + `DEL` en un mismo script Lua: atomico dentro
 * de Redis, evita que un mensaje que llega justo entre leer y limpiar el
 * buffer se pierda o se cuente dos veces.
 */
const DRAIN_BUFFER_SCRIPT = `
  local items = redis.call("LRANGE", KEYS[1], 0, -1)
  redis.call("DEL", KEYS[1])
  return items
`;

export type InboundBufferOptions = {
  debounceMs: number;
};

/**
 * Buffer/debounce de mensajes inbound por conversacion (docs/spec/02_STATE_MACHINE.md §12).
 * Vive en la API sobre Redis, nunca en n8n. Cada `push` reprograma un
 * temporizador corto; al vencer sin mensajes nuevos, todos los acumulados
 * desde el ultimo procesamiento se entregan juntos como una sola unidad de
 * trabajo a `onFlush` (en produccion, `ProcessBufferedMessagesUseCase`).
 */
export class InboundBufferService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly processingConversations = new Set<string>();

  constructor(
    private readonly redisClient: Redis,
    private readonly onFlush: FlushHandler,
    private readonly options: InboundBufferOptions,
    private readonly logger: Logger,
  ) {}

  async push(conversationId: string, messageId: string): Promise<void> {
    await this.redisClient.rpush(this.bufferKey(conversationId), messageId);
    this.logger.info({ conversationId, messageId }, "mensaje empujado al buffer, debounce reprogramado");
    this.reschedule(conversationId);
  }

  /**
   * Verifica si la conversación tiene un debounce timer activo.
   */
  hasActiveBuffer(conversationId: string): boolean {
    return this.timers.has(conversationId);
  }

  /**
   * Resetea el timer de debounce si está activo (edición recibida pre-flush).
   * Retorna true si el debounce estaba activo y fue reprogramado; false si ya se procesó.
   */
  touch(conversationId: string): boolean {
    if (this.timers.has(conversationId)) {
      this.logger.info({ conversationId }, "edicion recibida durante debounce: timer reseteado");
      this.reschedule(conversationId);
      return true;
    }
    return false;
  }

  /** Fuerza el flush inmediato de una conversacion (util en tests). */
  async flushNow(conversationId: string): Promise<void> {
    const existing = this.timers.get(conversationId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(conversationId);
    }
    await this.drain(conversationId);
  }

  /** Cancela todos los temporizadores pendientes (shutdown ordenado). */
  clearAllTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private reschedule(conversationId: string): void {
    const existing = this.timers.get(conversationId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.drain(conversationId).catch((error) => {
        this.logger.error({ err: error, conversationId }, "fallo al procesar el buffer de la conversacion");
      });
    }, this.options.debounceMs);
    this.timers.set(conversationId, timer);
  }

  private async drain(conversationId: string): Promise<void> {
    this.timers.delete(conversationId);

    // Evitar flushes paralelos para la misma conversación (race condition):
    // Si ya se está procesando un lote previo, reprogramar para esperar que finalice.
    if (this.processingConversations.has(conversationId)) {
      this.logger.info(
        { conversationId },
        "procesamiento previo aún en curso; postergando nuevo flush hasta que finalice",
      );
      this.reschedule(conversationId);
      return;
    }

    const key = this.bufferKey(conversationId);
    const messageIds = (await this.redisClient.eval(DRAIN_BUFFER_SCRIPT, 1, key)) as string[];
    if (messageIds.length === 0) {
      return;
    }
    this.logger.info(
      { conversationId, messageCount: messageIds.length, messageIds },
      "debounce vencido, entregando unidad de trabajo acumulada",
    );

    this.processingConversations.add(conversationId);
    try {
      await this.onFlush(conversationId, messageIds);
    } finally {
      this.processingConversations.delete(conversationId);
      // Si llegaron nuevos mensajes durante la ejecución de onFlush, reprogramar para procesarlos ordenadamente
      const remaining = await this.redisClient.llen(key);
      if (remaining > 0 && !this.timers.has(conversationId)) {
        this.reschedule(conversationId);
      }
    }
  }

  private bufferKey(conversationId: string): string {
    return `buffer:conversation:${conversationId}:messages`;
  }
}
