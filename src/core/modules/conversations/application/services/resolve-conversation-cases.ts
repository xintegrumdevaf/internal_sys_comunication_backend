import { TERMINAL_CASE_STATUSES, type Case } from "../../../cases/domain/case.entity";
import type { Conversation } from "../../domain/conversation.entity";

/**
 * Resuelve de forma uniforme el caso activo o el caso histórico de cierre
 * para una conversación.
 *
 * Invariante: si la conversación ya está `resolved` o `closed` y no tiene un
 * `activeCaseId` vivo explícito, nunca se rescatan casos no terminales huérfanos
 * como si estuvieran activos; se devuelve el último caso completado/cerrado para
 * trazabilidad (`lastAttendedBy`).
 */
export function resolveConversationCases(
  conv: Pick<Conversation, "status" | "activeCaseId">,
  cases: Case[],
): {
  activeCase: Case | null;
  recordCase: Case | null;
  filterCase: Case | null;
} {
  const isClosedRecord = conv.status === "resolved" || conv.status === "closed";

  const explicitActive = conv.activeCaseId
    ? (cases.find(
        (item) => item.id === conv.activeCaseId && !TERMINAL_CASE_STATUSES.includes(item.status),
      ) ?? null)
    : null;

  const activeCase = isClosedRecord
    ? explicitActive
    : (explicitActive ??
        cases.find((item) => item.status === "HUMAN_ACTIVE" || item.status === "ESCALATED") ??
        cases.find((item) => item.status === "ACTIVE" || item.status === "WAITING_USER") ??
        null);

  const recordCase =
    !activeCase && isClosedRecord
      ? ([...cases].sort((a, b) => {
          const aCompleted = a.status === "COMPLETED" ? 1 : 0;
          const bCompleted = b.status === "COMPLETED" ? 1 : 0;
          if (aCompleted !== bCompleted) return bCompleted - aCompleted;
          return b.updatedAt.getTime() - a.updatedAt.getTime();
        })[0] ?? null)
      : null;

  return {
    activeCase,
    recordCase,
    filterCase: activeCase ?? recordCase,
  };
}
