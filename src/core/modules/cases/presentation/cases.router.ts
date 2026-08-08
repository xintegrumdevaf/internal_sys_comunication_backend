import { Router, type Request } from "express";
import { z } from "zod";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { ClaimCaseUseCase } from "../../escalation/application/use-cases/claim-case.use-case";
import type { AssignCaseUseCase } from "../../escalation/application/use-cases/assign-case.use-case";
import type { DisableAutomationUseCase } from "../../escalation/application/use-cases/disable-automation.use-case";
import type { ReactivateAutomationUseCase } from "../../escalation/application/use-cases/reactivate-automation.use-case";
import type { GetCaseSummaryUseCase } from "../../escalation/application/use-cases/list-escalations.use-case";
import type { CaseRepositoryPort } from "../application/ports/case.repository.port";

export type CasesRouterDeps = {
  caseRepo: CaseRepositoryPort;
  claimCase: ClaimCaseUseCase;
  assignCase: AssignCaseUseCase;
  disableAutomation: DisableAutomationUseCase;
  reactivateAutomation: ReactivateAutomationUseCase;
  getCaseSummary: GetCaseSummaryUseCase;
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

/**
 * Acciones de caso Etapa 6 (03_API_CONTRACT.md §C.2) + summary §C.1.
 * Actor: `x-agent-id` o `agentUserId` en body (claim).
 */
export function createCasesRouter(deps: CasesRouterDeps): Router {
  const router = Router();

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
      res.status(204).send();
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
