import type { SessionStorePort } from "../ports/session-store.port";

/** docs/spec/06_BACKEND_GAPS.md §1.b `POST /api/auth/logout` — revoca la sesion en el servidor de inmediato. */
export class LogoutUseCase {
  constructor(private readonly sessionStore: SessionStorePort) {}

  async execute(token: string): Promise<void> {
    await this.sessionStore.destroy(token);
  }
}
