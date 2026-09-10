import { describe, expect, it } from "vitest";
import { normalizeNationalId } from "../../src/core/modules/customers/domain/national-id";

describe("normalizeNationalId", () => {
  it("autocompleta con '0' si tiene 9 dígitos", () => {
    expect(normalizeNationalId("942783440")).toBe("0942783440");
    expect(normalizeNationalId(942783440)).toBe("0942783440");
  });

  it("conserva 10 dígitos sin modificar", () => {
    expect(normalizeNationalId("0942783440")).toBe("0942783440");
    expect(normalizeNationalId("1712345678")).toBe("1712345678");
  });

  it("autocompleta con '0' si tiene 12 dígitos (RUC con 0 omitido)", () => {
    expect(normalizeNationalId("942783440001")).toBe("0942783440001");
  });

  it("conserva RUC de 13 dígitos", () => {
    expect(normalizeNationalId("0942783440001")).toBe("0942783440001");
  });

  it("limpia caracteres no numéricos antes de evaluar", () => {
    expect(normalizeNationalId(" 942-783-440 ")).toBe("0942783440");
    expect(normalizeNationalId("094-278-3440")).toBe("0942783440");
  });

  it("retorna string vacío si es inválido o nulo", () => {
    expect(normalizeNationalId(null)).toBe("");
    expect(normalizeNationalId(undefined)).toBe("");
    expect(normalizeNationalId("abc")).toBe("");
  });
});
