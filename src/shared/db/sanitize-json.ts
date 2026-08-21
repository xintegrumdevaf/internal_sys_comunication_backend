/**
 * PostgreSQL json/jsonb columns do not support \u0000 (null byte) sequences.
 * This sanitizer recursively strips null characters from strings, arrays, and objects
 * before persisting to PostgreSQL (e.g. raw terminal OLT/MikroTik command output in n8n).
 */
export function sanitizeForPostgresJson<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Strip both raw \0 characters and escaped \u0000 sequences
    return value.replace(/\0/g, "").replace(/\\u0000/g, "") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForPostgresJson(item)) as unknown as T;
  }
  if (typeof value === "object") {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      res[k.replace(/\0/g, "")] = sanitizeForPostgresJson(v);
    }
    return res as T;
  }
  return value;
}
