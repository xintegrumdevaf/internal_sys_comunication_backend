import argon2 from "argon2";
import { randomInt } from "node:crypto";

/**
 * Unico punto del proyecto que sabe como se hashean/verifican contrasenas
 * (argon2id, decision documentada en docs/spec/06_BACKEND_GAPS.md §1.b).
 * Nada fuera de aqui debe importar `argon2` directamente — asi si algun dia
 * cambia el algoritmo, es un solo archivo.
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return argon2.hash(plainPassword, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plainPassword: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plainPassword);
  } catch {
    // hash corrupto/formato viejo — nunca tratamos esto como "contrasena valida".
    return false;
  }
}

const TEMP_PASSWORD_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // sin 0/O/1/l/I (ambiguos)

/**
 * Contrasena temporal legible para comunicar de viva voz/chat al agente
 * (docs/spec/06_BACKEND_GAPS.md §1.b — se genera al crear un agente o al
 * restablecer su contrasena; nunca se elige a mano ni se envia por email
 * porque este proyecto no tiene infraestructura de correo todavia).
 */
export function generateTemporaryPassword(length = 12): string {
  let password = "";
  for (let i = 0; i < length; i++) {
    password += TEMP_PASSWORD_CHARSET[randomInt(TEMP_PASSWORD_CHARSET.length)];
  }
  return password;
}
