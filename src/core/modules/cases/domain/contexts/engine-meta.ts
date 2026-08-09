/**
 * Metadata del motor (docs/spec/01_DATA_MODEL.md §4 + 02_STATE_MACHINE.md §13).
 * No es dato de negocio ni lo ve/toca la IA.
 */
export type CaseEngineMeta = {
  /** Contador de reintentos del WaitingStep actual. */
  waitingAttempts?: number;
  /** Estado WAITING_* actual (para resetear al cambiar de paso). */
  waitingState?: string;
  /** Campos que faltaron en el último intento (para composeReply). */
  missingFields?: string[];
};

export function getEngineMeta(context: { _engine?: CaseEngineMeta }): CaseEngineMeta {
  return context._engine ?? {};
}

export function withEngineMeta<T extends { _engine?: CaseEngineMeta }>(
  context: T,
  engine: CaseEngineMeta,
): T {
  return { ...context, _engine: engine };
}

export function resetWaitingAttempts<T extends { _engine?: CaseEngineMeta }>(
  context: T,
  waitingState: string,
): T {
  return withEngineMeta(context, {
    ...getEngineMeta(context),
    waitingAttempts: 0,
    waitingState,
    missingFields: undefined,
  });
}

export function bumpWaitingAttempts<T extends { _engine?: CaseEngineMeta }>(
  context: T,
  missingFields: string[],
): T {
  const current = getEngineMeta(context).waitingAttempts ?? 0;
  return withEngineMeta(context, {
    ...getEngineMeta(context),
    waitingAttempts: current + 1,
    missingFields,
  });
}

export function clearWaitingMeta<T extends { _engine?: CaseEngineMeta }>(context: T): T {
  const { waitingAttempts: _a, waitingState: _s, missingFields: _m, ...rest } =
    getEngineMeta(context);
  const next: CaseEngineMeta = { ...rest };
  return withEngineMeta(context, next);
}
