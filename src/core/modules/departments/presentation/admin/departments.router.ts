import { Router } from "express";
import { z } from "zod";
import { validationError } from "../../../../../shared/errors/domain-errors";
import { requireRole } from "../../../../../shared/http/require-auth";
import type { CreateDepartmentUseCase } from "../../application/use-cases/create-department.use-case";
import type { UpdateDepartmentUseCase } from "../../application/use-cases/update-department.use-case";
import type { DeactivateDepartmentUseCase } from "../../application/use-cases/deactivate-department.use-case";

export type DepartmentsAdminRouterDeps = {
  createDepartment: CreateDepartmentUseCase;
  updateDepartment: UpdateDepartmentUseCase;
  deactivateDepartment: DeactivateDepartmentUseCase;
};

const visibilitySchema = z.enum(["shared", "restricted"]);

const createBodySchema = z.object({
  name: z.string().trim().min(2),
  slug: z.string().trim().min(2),
  visibility: visibilitySchema.optional(),
});

const updateBodySchema = z.object({
  name: z.string().trim().min(2).optional(),
  slug: z.string().trim().min(2).optional(),
  visibility: visibilitySchema.optional(),
  active: z.boolean().optional(),
});

/**
 * docs/spec/06_BACKEND_GAPS.md §3 — CRUD de departamentos (crear/editar/desactivar), 
 * restringido a `role=admin`.
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

  return router;
}
