/**
 * docs/spec/02_STATE_MACHINE.md §7 — umbral configurable por intent (p. ej.
 * `billing.*` exige mas certeza que `support.*` por implicar montos).
 */
const DEFAULT_THRESHOLD = 0.6;

const THRESHOLD_OVERRIDE_BY_PREFIX: Readonly<Record<string, number>> = {
  billing: 0.8,
};

export function confidenceThreshold(intent: string): number {
  const prefix = intent.split(".")[0] ?? "";
  return THRESHOLD_OVERRIDE_BY_PREFIX[prefix] ?? DEFAULT_THRESHOLD;
}
