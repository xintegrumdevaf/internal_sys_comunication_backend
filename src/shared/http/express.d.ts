import type { Logger } from "../logging/logger";

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      log: Logger;
      /** Buffer crudo del body, capturado por el `verify` de express.json() — necesario para validar HMAC de webhooks. */
      rawBody?: Buffer;
    }
  }
}

export {};
