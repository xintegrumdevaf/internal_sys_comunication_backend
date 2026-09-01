/**
 * Normaliza una cédula o RUC ecuatoriano.
 * Si contiene 9 dígitos numéricos (se omitió el 0 inicial, ej: '942783440'),
 * autocompleta con '0' al inicio a 10 dígitos ('0942783440').
 * Si contiene 12 dígitos (RUC con 0 inicial omitido), autocompleta con '0' a 13 dígitos.
 */
export function normalizeNationalId(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const cleaned = String(value).replace(/\D/g, "").trim();
  if (cleaned.length === 9) {
    return cleaned.padStart(10, "0");
  }
  if (cleaned.length === 12) {
    return cleaned.padStart(13, "0");
  }
  return cleaned;
}
