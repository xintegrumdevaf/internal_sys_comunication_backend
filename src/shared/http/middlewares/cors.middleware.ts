import type { NextFunction, Request, Response } from "express";

/**
 * CORS para el frontend (docs/API_ENDPOINTS.md — la API se consume desde un
 * navegador en otro origin: distinto puerto de Vite dev = distinto origin).
 * Sin este middleware, el navegador bloquea toda llamada aunque el backend
 * responda 200 (el fetch/preflight se rechaza del lado del cliente).
 *
 * `CORS_ALLOWED_ORIGINS` (env) es una lista separada por comas. Si está vacía:
 * - en development, se refleja cualquier `Origin` (conveniencia local — el
 *   puerto de Vite cambia seguido cuando el anterior queda ocupado).
 * - en production, no se permite ningún origin (falla explícito en vez de
 *   abrir CORS por accidente en un despliegue real).
 */
export function createCors(allowedOrigins: string, nodeEnv: string) {
  const list = allowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const allowAny = list.length === 0 && nodeEnv === "development";

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header("origin");
    if (origin && (allowAny || list.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      // Requerido para que el navegador adjunte/acepte la cookie de sesion
      // httpOnly en requests cross-origin (docs/spec/06_BACKEND_GAPS.md
      // §1.b). Nunca se combina con Access-Control-Allow-Origin: "*" — el
      // navegador lo rechazaria, y aqui siempre reflejamos un origin puntual.
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    const requestedHeaders = req.header("access-control-request-headers");
    res.setHeader(
      "Access-Control-Allow-Headers",
      requestedHeaders || "Content-Type, Authorization, x-agent-id, x-correlation-id",
    );

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
