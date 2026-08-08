import { TERMINAL_CASE_STATUSES, type Case } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { Logger } from "../../../../../shared/logging/logger";

/**
 * docs/spec/02_STATE_MACHINE.md §8: `case.expires_at = last_activity_at +
 * expiration_hours(workflow_type)`. Un caso EXPIRED no bloquea abrir un Case
 * nuevo del mismo workflow_type en la misma conversacion mas adelante.
 */
export class ExpirationService {
  constructor(
    private readonly caseRepo: CaseRepositoryPort,
    private readonly logger: Logger,
  ) {}

  isExpired(caseEntity: Case, now: Date = new Date()): boolean {
    if (TERMINAL_CASE_STATUSES.includes(caseEntity.status)) {
      return false;
    }
    return caseEntity.expiresAt !== null && caseEntity.expiresAt.getTime() <= now.getTime();
  }

  /**
   * Calculo perezoso + barrido: mueve a EXPIRED todos los casos vencidos en
   * estado no terminal. Se puede invocar desde un proceso periodico o al leer
   * un caso puntual (aqui se expone el barrido completo, la lectura puntual
   * puede llamar `isExpired` directamente sin tocar la base).
   */
  async expireDueCases(now: Date = new Date()): Promise<Case[]> {
    const candidates = await this.caseRepo.listAutomatableExpiring(now);
    const expired: Case[] = [];

    for (const candidate of candidates) {
      const aggregate = await this.caseRepo.findById(candidate.id);
      if (!aggregate || !this.isExpired(aggregate.case, now)) {
        continue;
      }

      const result = await this.caseRepo.applyTransition({
        caseId: aggregate.case.id,
        expectedCaseVersion: aggregate.case.version,
        expectedWorkflowVersion: aggregate.workflowInstance.version,
        status: "EXPIRED",
        context: aggregate.case.context,
        currentState: aggregate.workflowInstance.currentState,
        expiresAt: null,
      });
      await this.caseRepo.appendEvent(aggregate.case.id, "CASE_EXPIRED", {});
      this.logger.info(
        { caseId: aggregate.case.id, workflowType: aggregate.case.workflowType },
        "caso vencido por inactividad",
      );
      expired.push(result.case);
    }

    if (candidates.length > 0) {
      this.logger.info(
        { candidateCount: candidates.length, expiredCount: expired.length },
        "barrido de expiracion de casos completado",
      );
    }

    return expired;
  }
}
