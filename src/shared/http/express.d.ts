import type { Agent } from "../../core/modules/departments/domain/agent.entity";
import type { Logger } from "../logging/logger.port";

declare global {
  namespace Express {
    interface Request {
      /** Poblado por request-logger.middleware.ts — logger con correlationId ya inyectado. */
      log?: Logger;
      /** Poblado por request-logger.middleware.ts (AGENTS.md: logging con correlationId end-to-end). */
      correlationId?: string;
      /** Poblado por el verify() de express.json() en container.ts (firma de WhatsApp). */
      rawBody?: Buffer;
      /** Poblado por session.middleware.ts a partir de la cookie real — null si no hay sesion valida. */
      agent?: Agent | null;
      /** Token de la cookie de sesion actual (para poder destruirla en /api/auth/logout). */
      sessionToken?: string | null;
    }
  }
}

export {};
