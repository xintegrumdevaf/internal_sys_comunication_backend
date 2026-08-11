export type AgentRole = "agent" | "manager" | "admin";

export interface Agent {
  id: string;
  name: string;
  email: string;
  role: AgentRole;
  primaryDepartmentId: string | null;
  active: boolean;
  createdAt: Date;
  /**
   * Hash argon2 de la contrasena (nunca texto plano). `null` = agente sin
   * contrasena configurada todavia (no puede iniciar sesion hasta que un
   * admin la genere con `POST /api/agents/:id/reset-password`).
   * NUNCA debe salir en una respuesta HTTP — usar `toPublicAgentDto`.
   */
  passwordHash: string | null;
}
