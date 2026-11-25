/**
 * Builds LIKE patterns from numeric phone digits, normalizing local vs international
 * Ecuador WhatsApp prefixes (`09...` <-> `5939...`) so contact search finds records
 * regardless of formatting (`+593 987...`, `593987...`, `0987...`).
 */
export function buildPhoneDigitVariants(rawQuery: string): string[] {
  const digits = rawQuery.replace(/\D/g, "");
  if (digits.length < 4) return [];

  const variants = new Set<string>([digits]);

  if (digits.startsWith("593") && digits.length >= 7) {
    const national = digits.slice(3);
    variants.add(national);
    variants.add(`0${national}`);
  } else if (digits.startsWith("0") && digits.length >= 6) {
    const national = digits.slice(1);
    variants.add(national);
    variants.add(`593${national}`);
  }

  return Array.from(variants).map((v) => `%${v}%`);
}
