export interface Session {
  /** Token opaco (no JWT) — la unica cosa que sale al navegador, en una cookie httpOnly. */
  token: string;
  agentId: string;
  createdAt: Date;
}
