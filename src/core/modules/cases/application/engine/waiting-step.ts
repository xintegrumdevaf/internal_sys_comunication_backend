/**
 * Contrato de un paso WAITING_USER (docs/spec/02_STATE_MACHINE.md §13).
 */
export type WaitingStep = {
  pendingQuestion: string;
  requireAll?: string[];
  requireAny?: string[];
  /** Default 2. */
  maxAttempts?: number;
};

export function missingRequiredFields(
  step: WaitingStep,
  entities: Record<string, unknown>,
): string[] {
  const present = (key: string): boolean => {
    const value = entities[key];
    if (value === undefined || value === null) return false;
    if (typeof value === "string" && value.trim() === "") return false;
    return true;
  };

  if (step.requireAll && step.requireAll.length > 0) {
    return step.requireAll.filter((key) => !present(key));
  }
  if (step.requireAny && step.requireAny.length > 0) {
    const anyOk = step.requireAny.some((key) => present(key));
    return anyOk ? [] : [...step.requireAny];
  }
  return [];
}

export function maxAttemptsOf(step: WaitingStep): number {
  return step.maxAttempts ?? 2;
}
