import type { CookieOptions } from "express";
import type { Env } from "../config/env";

/** Nombre de la cookie de sesion (docs/spec/06_BACKEND_GAPS.md §1.b). */
export const SESSION_COOKIE_NAME = "sid";

/**
 * Parser minimo de `Cookie:` — no agregamos `cookie-parser` como dependencia
 * por una sola cookie propia (httpOnly, generada solo por este backend).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * `SameSite=Lax` alcanza para proteger de CSRF en este proyecto porque:
 * (a) todos los GET son de solo lectura (sin efectos secundarios — ver
 * docs/skills/api-design-best-practices.md), y Lax siempre bloquea el envio
 * de la cookie en requests cross-site que no sean una navegacion de
 * top-level con metodo seguro; (b) frontend y backend viven en el mismo
 * "site" (mismo dominio registrable) en todos los entornos previstos.
 * `Secure` solo se exige en produccion para no romper `http://localhost` en
 * desarrollo.
 */
export function sessionCookieOptions(env: Env, ttlSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: ttlSeconds * 1000,
  };
}
