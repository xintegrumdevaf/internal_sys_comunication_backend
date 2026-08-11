import { randomUUID } from "node:crypto";
import type { Session } from "../../src/core/modules/auth/domain/session.entity";
import type { SessionStorePort } from "../../src/core/modules/auth/application/ports/session-store.port";

export class SessionStoreFake implements SessionStorePort {
  readonly sessions = new Map<string, Session>();

  async create(agentId: string, _ttlSeconds: number): Promise<Session> {
    const session: Session = { token: randomUUID(), agentId, createdAt: new Date() };
    this.sessions.set(session.token, session);
    return session;
  }

  async touch(token: string, _ttlSeconds: number): Promise<Session | null> {
    return this.sessions.get(token) ?? null;
  }

  async destroy(token: string): Promise<void> {
    this.sessions.delete(token);
  }
}
