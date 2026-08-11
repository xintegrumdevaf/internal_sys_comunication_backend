import { describe, expect, it } from "vitest";
import {
  generateTemporaryPassword,
  hashPassword,
  verifyPassword,
} from "../../src/shared/security/password-hasher";

describe("password-hasher", () => {
  it("hashPassword + verifyPassword hacen roundtrip correctamente", async () => {
    const hash = await hashPassword("Sup3rSecreta!");
    expect(await verifyPassword(hash, "Sup3rSecreta!")).toBe(true);
    expect(await verifyPassword(hash, "otra-cosa")).toBe(false);
  });

  it("verifyPassword nunca lanza con un hash corrupto — devuelve false", async () => {
    await expect(verifyPassword("no-es-un-hash-argon2-valido", "cualquiera")).resolves.toBe(false);
  });

  it("generateTemporaryPassword genera 12 caracteres sin ambiguos (0/O/1/l/I)", () => {
    const password = generateTemporaryPassword();
    expect(password).toHaveLength(12);
    expect(password).not.toMatch(/[0O1lI]/);
  });

  it("generateTemporaryPassword no repite el mismo valor en llamadas consecutivas", () => {
    const a = generateTemporaryPassword();
    const b = generateTemporaryPassword();
    expect(a).not.toBe(b);
  });
});
