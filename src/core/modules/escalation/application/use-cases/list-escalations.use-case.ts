import { authorizationError, notFound } from "../../../../../shared/errors/domain-errors";
import type { Escalation, EscalationSummary } from "../../domain/escalation.entity";
import type { EscalationRepositoryPort } from "../ports/escalation.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import { assertCanReadEscalation, resolveActingAgent } from "./agent-case-auth";
import { CaseSummaryBuilderService } from "../services/case-summary-builder.service";
import type { WorkflowExecutionRepositoryPort } from "../../../cases/application/ports/workflow-execution.repository.port";

export class GetCaseSummaryUseCase {
  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      escalationRepo: EscalationRepositoryPort;
      workflowExecutionRepo: WorkflowExecutionRepositoryPort;
      departmentRepo: DepartmentRepositoryPort;
      summaryBuilder: CaseSummaryBuilderService;
    },
  ) {}

  async execute(caseId: string): Promise<EscalationSummary> {
    const aggregate = await this.deps.caseRepo.findById(caseId);
    if (!aggregate) throw notFound(`Caso ${caseId} no encontrado`);

    const status = aggregate.case.status;
    if (status !== "ESCALATED" && status !== "HUMAN_ACTIVE") {
      throw authorizationError("El resumen solo está disponible para casos escalados o HUMAN_ACTIVE");
    }

    const escalation = await this.deps.escalationRepo.findByCaseId(caseId);
    if (escalation) return escalation.summary;

    const executions = await this.deps.workflowExecutionRepo.listByCase(caseId);
    const events = await this.deps.caseRepo.listEvents(caseId);
    const department = aggregate.case.departmentId
      ? await this.deps.departmentRepo.findById(aggregate.case.departmentId)
      : null;
    return this.deps.summaryBuilder.build({
      caseEntity: aggregate.case,
      reason: "Sin fila de escalación persistida",
      executions,
      events,
      departmentSlug: department?.slug ?? null,
    });
  }
}

export class ListEscalationsUseCase {
  constructor(
    private readonly deps: {
      escalationRepo: EscalationRepositoryPort;
      agentRepo: AgentRepositoryPort;
      departmentRepo: DepartmentRepositoryPort;
    },
  ) {}

  async execute(input: {
    agentUserId: string;
    departmentId?: string | null;
    status?: "PENDING" | "ASSIGNED" | "RESOLVED";
    triage?: boolean;
  }): Promise<Escalation[]> {
    const agent = await resolveActingAgent(this.deps.agentRepo, input.agentUserId);
    const triage = input.triage === true || input.departmentId === null;

    if (triage) {
      await assertCanReadEscalation({
        agent,
        departmentId: null,
        agentRepo: this.deps.agentRepo,
        departmentRepo: this.deps.departmentRepo,
      });
      return this.deps.escalationRepo.list({
        triage: true,
        status: input.status,
      });
    }

    if (input.departmentId) {
      await assertCanReadEscalation({
        agent,
        departmentId: input.departmentId,
        agentRepo: this.deps.agentRepo,
        departmentRepo: this.deps.departmentRepo,
      });
    }

    return this.deps.escalationRepo.list({
      departmentId: input.departmentId,
      status: input.status,
    });
  }
}
