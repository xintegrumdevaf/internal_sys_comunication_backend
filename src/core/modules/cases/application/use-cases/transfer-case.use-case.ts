import { notFound, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { Case } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";

/**
 * Transferencia de departamento (03_API_CONTRACT.md §C.2), auditada.
 * Conserva context y currentState; no reinicia el workflow.
 */
export class TransferCaseUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      departmentRepo: DepartmentRepositoryPort;
      auditRepo: AuditRepositoryPort;
      logger: Logger;
    },
  ) {}

  async execute(input: {
    caseId: string;
    toDepartmentId: string;
    reason: string;
    agentUserId: string;
  }): Promise<Case> {
    if (!input.reason.trim()) throw validationError("reason requerido");
    const dept = await this.deps.departmentRepo.findById(input.toDepartmentId);
    if (!dept) throw notFound(`Departamento ${input.toDepartmentId} no encontrado`);

    const aggregate = await this.deps.caseRepo.findById(input.caseId);
    if (!aggregate) throw notFound(`Caso ${input.caseId} no encontrado`);

    const result = await this.deps.caseRepo.applyTransition({
      caseId: aggregate.case.id,
      expectedCaseVersion: aggregate.case.version,
      expectedWorkflowVersion: aggregate.workflowInstance.version,
      status: aggregate.case.status,
      context: aggregate.case.context,
      currentState: aggregate.workflowInstance.currentState,
      departmentId: input.toDepartmentId,
      expiresAt: aggregate.case.expiresAt,
    });

    // Al transferir, se libera la asignación para que el nuevo depto reclame.
    await this.deps.caseRepo.setAssignedAgent(aggregate.case.id, null);
    await this.deps.caseRepo.appendEvent(aggregate.case.id, "CASE_TRANSFERRED", {
      toDepartmentId: input.toDepartmentId,
      reason: input.reason,
    });
    await this.deps.auditRepo.record({
      action: "CASE_TRANSFERRED",
      resourceType: "case",
      resourceId: aggregate.case.id,
      actorId: input.agentUserId,
      metadata: {
        toDepartmentId: input.toDepartmentId,
        reason: input.reason,
        previousDepartmentId: aggregate.case.departmentId,
      },
    });
    this.deps.logger.info(
      { caseId: result.case.id, toDepartmentId: input.toDepartmentId },
      "caso transferido de departamento",
    );
    return result.case;
  }
}
