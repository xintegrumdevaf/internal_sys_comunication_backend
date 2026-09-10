import { Router } from "express";
import { z } from "zod";
import { validationError } from "../../../../../shared/errors/domain-errors";
import { requireRole } from "../../../../../shared/http/require-auth";
import type { CreateDepartmentUseCase } from "../../application/use-cases/create-department.use-case";
import type { UpdateDepartmentUseCase } from "../../application/use-cases/update-department.use-case";
import type { DeactivateDepartmentUseCase } from "../../application/use-cases/deactivate-department.use-case";
import type {
  AddDepartmentCaseUseCase,
  DeleteDepartmentCaseUseCase,
  ListDepartmentCasesUseCase,
} from "../../application/use-cases/manage-department-cases.use-case";

export type DepartmentsAdminRouterDeps = {
  createDepartment: CreateDepartmentUseCase;
  updateDepartment: UpdateDepartmentUseCase;
  deactivateDepartment: DeactivateDepartmentUseCase;
  addCase?: AddDepartmentCaseUseCase;
  deleteCase?: DeleteDepartmentCaseUseCase;
  listCases?: ListDepartmentCasesUseCase;
};

const visibilitySchema = z.enum(["shared", "restricted"]);
const handlingModeSchema = z.enum(["ai_assisted", "human_direct"]);

const caseItemSchema = z.object({
  id: z.string().uuid().optional(),
  label: z.string().trim().min(2),
  description: z.string().trim().min(3),
  intentKey: z.string().trim().optional(),
  handlingMode: handlingModeSchema.optional(),
  workflowType: z.string().trim().optional(),
  active: z.boolean().optional(),
});

const createBodySchema = z.object({
  name: z.string().trim().min(2),
  slug: z.string().trim().min(2),
  description: z.string().trim().optional(),
  visibility: visibilitySchema.optional(),
  cases: z.array(caseItemSchema).optional(),
});

const updateBodySchema = z.object({
  name: z.string().trim().min(2).optional(),
  slug: z.string().trim().min(2).optional(),
  description: z.string().trim().optional(),
  visibility: visibilitySchema.optional(),
  active: z.boolean().optional(),
  cases: z.array(caseItemSchema).optional(),
});

/**
 * docs/spec/06_BACKEND_GAPS.md §3 — CRUD de departamentos (crear/editar/desactivar)
 * y gestión dinámica de casos/solicitudes atendidas, restringido a `role=admin`.
 */
export function createDepartmentsAdminRouter(deps: DepartmentsAdminRouterDeps): Router {
  const router = Router();

  router.post("/api/departments", async (req, res, next) => {
    try {
      const admin = requireRole(req, ["admin"]);
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }
      const department = await deps.createDepartment.execute({
        ...parsed.data,
        actorId: admin.id,
      });
      res.status(201).json({ data: department });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/departments/:id", async (req, res, next) => {
    try {
      const admin = requireRole(req, ["admin"]);
      const parsed = updateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }
      const department = await deps.updateDepartment.execute({
        departmentId: req.params.id!,
        patch: parsed.data,
        actorId: admin.id,
      });
      res.json({ data: department });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/departments/:id", async (req, res, next) => {
    try {
      const admin = requireRole(req, ["admin"]);
      const department = await deps.deactivateDepartment.execute({
        departmentId: req.params.id!,
        actorId: admin.id,
      });
      res.json({ data: department });
    } catch (error) {
      next(error);
    }
  });

  // --- Endpoints granulares de Casos por Departamento ---

  router.get("/api/departments/:id/cases", async (req, res, next) => {
    try {
      requireRole(req, ["admin", "manager"]);
      if (!deps.listCases) {
        res.json({ data: [] });
        return;
      }
      const cases = await deps.listCases.execute(req.params.id);
      res.json({ data: cases });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/departments/:id/cases", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      if (!deps.addCase) {
        throw validationError("Operación no soportada");
      }
      const parsed = caseItemSchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
      }
      const created = await deps.addCase.execute({
        departmentId: req.params.id!,
        ...parsed.data,
      });
      res.status(201).json({ data: created });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/departments/cases/:caseId", async (req, res, next) => {
    try {
      requireRole(req, ["admin"]);
      if (!deps.deleteCase) {
        throw validationError("Operación no soportada");
      }
      await deps.deleteCase.execute(req.params.caseId!);
      res.json({ message: "Caso eliminado con éxito" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
