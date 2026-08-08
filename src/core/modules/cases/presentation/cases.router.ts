import { Router, type Request } from "express";
import { z } from "zod";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { ClaimCaseUseCase } from "../../escalation/application/use-cases/claim-case.use-case";
import type { AssignCaseUseCase } from "../../escalation/application/use-cases/assign-case.use-case";
import type { DisableAutomationUseCase } from "../../escalation/application/use-cases/disable-automation.use-case";
import type { ReactivateAutomationUseCase } from "../../escalation/application/use-cases/reactivate-automation.use-case";
import type { GetCaseSummaryUseCase } from "../../escalation/application/use-cases/list-escalations.use-case";
import type { CaseRepositoryPort } from "../application/ports/case.repository.port";
import type { WorkflowExecutionRepositoryPort } from "../application/ports/workflow-execution.repository.port";
import type { CancelCaseUseCase } from "../application/use-cases/cancel-case.use-case";
import type { CompleteCaseUseCase } from "../application/use-cases/complete-case.use-case";
import type { TransferCaseUseCase } from "../application/use-cases/transfer-case.use-case";
import type { GetDashboardUseCase } from "../application/use-cases/get-dashboard.use-case";
import type { RealtimeBroadcaster } from "../../realtime/application/realtime-broadcaster";

export type CasesRouterDeps = {
  caseRepo: CaseRepositoryPort;
  workflowExecutionRepo: WorkflowExecutionRepositoryPort;
  claimCase: ClaimCaseUseCase;
  assignCase: AssignCaseUseCase;
  disableAutomation: DisableAutomationUseCase;
  reactivateAutomation: ReactivateAutomationUseCase;
  getCaseSummary: GetCaseSummaryUseCase;
  completeCase: CompleteCaseUseCase;
  cancelCase: CancelCaseUseCase;
  transferCase: TransferCaseUseCase;
  getDashboard: GetDashboardUseCase;
  broadcaster?: RealtimeBroadcaster;
};

const agentBodySchema = z.object({
  agentUserId: z.string().uuid(),
});

const assignBodySchema = z.object({
  agentUserId: z.string().uuid(),
  departmentId: z.string().uuid().nullable().optional(),
});

const disableBodySchema = z.object({
  reason: z.string().min(1),
  agentUserId: z.string().uuid().optional(),
});

const completeBodySchema = z.object({
  agentUserId: z.string().uuid().optional(),
  resolutionNote: z.string().optional(),
});

const cancelBodySchema = z.object({
  reason: z.string().min(1),
  agentUserId: z.string().uuid().optional(),
});

const transferBodySchema = z.object({
  toDepartmentId: z.string().uuid(),
  reason: z.string().min(1),
  agentUserId: z.string().uuid().optional(),
});

/**
 * Acciones/lecturas de caso (03_API_CONTRACT.md §C) — Etapas 6+7.
 */
export function createCasesRouter(deps: CasesRouterDeps): Router {
  const router = Router();

  router.get("/api/dashboard", async (req, res, next) => {
    try {
      const userId =
        (typeof req.query.userId === "string" && req.query.userId) || requireAgentHeader(req);
      const data = await deps.getDashboard.execute(userId);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/cases/:id", async (req, res, next) => {
    try {
      const aggregate = await deps.caseRepo.findById(req.params.id);
      if (!aggregate) {
        res.status(404).json({ error: { type: "NOT_FOUND", message: "Caso no encontrado" } });
        return;
      }
      const automation = await deps.caseRepo.getAutomationState(aggregate.case.id);
      res.json({
        data: {
          ...aggregate.case,
          currentState: aggregate.workflowInstance.currentState,
          automation: automation
            ? { enabled: automation.enabled, disabledReason: automation.disabledReason }
            : null,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/cases/:id/summary", async (req, res, next) => {
    try {
      const summary = await deps.getCaseSummary.execute(req.params.id);
      res.json({ data: summary });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/cases/:id/timeline", async (req, res, next) => {
    try {
      const aggregate = await deps.caseRepo.findById(req.params.id);
      if (!aggregate) {
        res.status(404).json({ error: { type: "NOT_FOUND", message: "Caso no encontrado" } });
        return;
      }
      const [executions, events] = await Promise.all([
        deps.workflowExecutionRepo.listByCase(req.params.id),
        deps.caseRepo.listEvents(req.params.id),
      ]);
      const timeline = [
        ...executions.map((e) => ({
          kind: "execution" as const,
          action: e.action,
          status: e.status,
          at: (e.completedAt ?? e.startedAt).toISOString(),
          output: e.output,
          error: e.error,
        })),
        ...events.map((ev) => ({
          kind: "event" as const,
          action: ev.type,
          status: "RECORDED",
          at: ev.occurredAt.toISOString(),
          payload: ev.payload,
        })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      res.json({ data: timeline });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cases/:id/claim", async (req, res, next) => {
    try {
      const parsed = agentBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      await deps.claimCase.execute({
        caseId: req.params.id,
        agentUserId: parsed.data.agentUserId,
      });
      deps.broadcaster?.publish({
        type: "CASE_CLAIMED",
        caseId: req.params.id,
        agentUserId: parsed.data.agentUserId,
      });
      deps.broadcaster?.publish({
        type: "HUMAN_ASSIGNED",
        caseId: req.params.id,
        agentUserId: parsed.data.agentUserId,
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cases/:id/assign", async (req, res, next) => {
    try {
      const actorAgentId = requireAgentHeader(req);
      const parsed = assignBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      await deps.assignCase.execute({
        caseId: req.params.id,
        actorAgentId,
        agentUserId: parsed.data.agentUserId,
        departmentId: parsed.data.departmentId,
      });
      deps.broadcaster?.publish({
        type: "HUMAN_ASSIGNED",
        caseId: req.params.id,
        agentUserId: parsed.data.agentUserId,
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cases/:id/reassign", async (req, res, next) => {
    try {
      const actorAgentId = requireAgentHeader(req);
      const parsed = assignBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      await deps.assignCase.execute({
        caseId: req.params.id,
        actorAgentId,
        agentUserId: parsed.data.agentUserId,
        departmentId: parsed.data.departmentId,
        reassign: true,
      });
      deps.broadcaster?.publish({
        type: "HUMAN_ASSIGNED",
        caseId: req.params.id,
        agentUserId: parsed.data.agentUserId,
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cases/:id/complete", async (req, res, next) => {
    try {
      const parsed = completeBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      const agentUserId = parsed.data.agentUserId ?? requireAgentHeader(req);
      const result = await deps.completeCase.execute({
        caseId: req.params.id,
        agentUserId,
        resolutionNote: parsed.data.resolutionNote,
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cases/:id/cancel", async (req, res, next) => {
    try {
      const parsed = cancelBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      const result = await deps.cancelCase.execute({
        caseId: req.params.id,
        reason: parsed.data.reason,
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cases/:id/transfer", async (req, res, next) => {
    try {
      const parsed = transferBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      const agentUserId = parsed.data.agentUserId ?? requireAgentHeader(req);
      const result = await deps.transferCase.execute({
        caseId: req.params.id,
        toDepartmentId: parsed.data.toDepartmentId,
        reason: parsed.data.reason,
        agentUserId,
      });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cases/:id/disable-automation", async (req, res, next) => {
    try {
      const parsed = disableBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }
      const agentUserId = parsed.data.agentUserId ?? requireAgentHeader(req);
      const automation = await deps.disableAutomation.execute({
        caseId: req.params.id,
        agentUserId,
        reason: parsed.data.reason,
      });
      res.json({ data: automation });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/cases/:id/reactivate-automation", async (req, res, next) => {
    try {
      const agentUserId =
        typeof req.body?.agentUserId === "string" ? req.body.agentUserId : requireAgentHeader(req);
      const result = await deps.reactivateAutomation.execute({
        caseId: req.params.id,
        agentUserId,
      });
      deps.broadcaster?.publish({ type: "AUTOMATION_ENABLED", caseId: req.params.id });
      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function requireAgentHeader(req: Request): string {
  const agentId = req.header("x-agent-id");
  if (!agentId) throw validationError("Header x-agent-id requerido");
  return agentId;
}
