import type { Session } from "../../domain/session.entity";

export interface SessionStorePort {
  create(agentId: string, ttlSeconds: number): Promise<Session>;
  /**
   * Busca la sesion y, si existe, renueva su TTL (expiracion deslizante:
   * docs/spec/06_BACKEND_GAPS.md §1.b). Devuelve null si no existe o ya
   * expiro por inactividad.
   */
  touch(token: string, ttlSeconds: number): Promise<Session | null>;
  destroy(token: string): Promise<void>;
}
