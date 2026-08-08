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

  constructor(
    private readonly redisClient: Redis,
    private readonly onFlush: FlushHandler,
    private readonly options: InboundBufferOptions,
    private readonly logger: Logger,
  ) {}

  async push(conversationId: string, messageId: string): Promise<void> {
    await this.redisClient.rpush(this.bufferKey(conversationId), messageId);
    this.logger.debug({ conversationId, messageId }, "mensaje empujado al buffer, debounce reprogramado");
    this.reschedule(conversationId);
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
    const key = this.bufferKey(conversationId);
    const messageIds = (await this.redisClient.eval(DRAIN_BUFFER_SCRIPT, 1, key)) as string[];
    if (messageIds.length === 0) {
      return;
    }
    this.logger.info(
      { conversationId, messageCount: messageIds.length, messageIds },
      "debounce vencido, entregando unidad de trabajo acumulada",
    );
    await this.onFlush(conversationId, messageIds);
  }

  private bufferKey(conversationId: string): string {
    return `buffer:conversation:${conversationId}:messages`;
  }
}
