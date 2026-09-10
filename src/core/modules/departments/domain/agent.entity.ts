export type AgentRole = "agent" | "manager" | "admin";

export interface Agent {
  id: string;
  name: string;
  email: string;
  role: AgentRole;
  primaryDepartmentId: string | null;
  /**
   * Departamentos adicionales a los que pertenece el agente (agent_membership).
   */
  departmentIds?: string[];
  active: boolean;
  /**
   * Opt-in al pool de auto-asignacion al escalar (`AutoAssignAgentService`).
   * Default `false`: un agente activo del departamento no recibe casos
   * automaticos hasta que un admin lo active via `PUT /api/agents/:id`.
   */
  autoAssignEnabled: boolean;
  /**
   * Indica si el agente debe cambiar su contrasena obligatoriamente en el siguiente login.
   * `true` por defecto al crearse o restablecerse la clave; `false` tras POST /api/auth/change-password.
   */
  mustChangePassword: boolean;
  createdAt: Date;
  /**
   * Hash argon2 de la contrasena (nunca texto plano). `null` = agente sin
   * contrasena configurada todavia (no puede iniciar sesion hasta que un
   * admin la genere con `POST /api/agents/:id/reset-password`).
   * NUNCA debe salir en una respuesta HTTP — usar `toPublicAgentDto`.
   */
  passwordHash: string | null;
}
