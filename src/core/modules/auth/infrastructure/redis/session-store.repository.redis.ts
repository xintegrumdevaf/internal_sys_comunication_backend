import { randomBytes } from "node:crypto";
import type Redis from "ioredis";
import type { Session } from "../../domain/session.entity";
import type { SessionStorePort } from "../../application/ports/session-store.port";

const KEY_PREFIX = "session:";

type SessionRecord = { agentId: string; createdAt: string };

/**
 * Sesiones en Redis (ya es dependencia del proyecto para colas/buffer —
 * docs/spec/06_BACKEND_GAPS.md §1.b). Token opaco aleatorio, nunca JWT: el
 * servidor es la unica fuente de verdad y una sesion se puede revocar de
 * inmediato borrando la clave (a diferencia de un JWT firmado, que sigue
 * siendo valido hasta que expira aunque se "cierre sesion").
 */
export class SessionStoreRedis implements SessionStorePort {
  constructor(private readonly redis: Redis) {}

  async create(agentId: string, ttlSeconds: number): Promise<Session> {
    const token = randomBytes(32).toString("hex");
    const createdAt = new Date();
    const record: SessionRecord = { agentId, createdAt: createdAt.toISOString() };
    await this.redis.set(KEY_PREFIX + token, JSON.stringify(record), "EX", ttlSeconds);
    return { token, agentId, createdAt };
  }

  async touch(token: string, ttlSeconds: number): Promise<Session | null> {
    const raw = await this.redis.get(KEY_PREFIX + token);
    if (!raw) return null;
    const record = JSON.parse(raw) as SessionRecord;
    await this.redis.expire(KEY_PREFIX + token, ttlSeconds);
    return { token, agentId: record.agentId, createdAt: new Date(record.createdAt) };
  }

  async destroy(token: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + token);
  }
}
