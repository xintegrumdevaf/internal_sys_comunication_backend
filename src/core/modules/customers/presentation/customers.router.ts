import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../../../../shared/http/require-auth";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { ListCustomersUseCase } from "../application/use-cases/list-customers.use-case";
import type { GetCustomerUseCase } from "../application/use-cases/get-customer.use-case";
import type { CreateCustomerUseCase } from "../application/use-cases/create-customer.use-case";
import type { UpdateCustomerUseCase } from "../application/use-cases/update-customer.use-case";
import type { DeleteCustomerUseCase } from "../application/use-cases/delete-customer.use-case";
import type { SyncCustomerIspUseCase } from "../application/use-cases/sync-customer-isp.use-case";

export interface CustomersRouterDeps {
  listCustomers: ListCustomersUseCase;
  getCustomer: GetCustomerUseCase;
  createCustomer: CreateCustomerUseCase;
  updateCustomer: UpdateCustomerUseCase;
  deleteCustomer: DeleteCustomerUseCase;
  syncCustomerIsp: SyncCustomerIspUseCase;
}

const createCustomerSchema = z.object({
  fullName: z.string().trim().min(1, "El nombre del contacto es requerido"),
  waPhone: z.string().trim().min(6, "El número de WhatsApp es requerido"),
  nationalId: z.string().trim().optional().nullable(),
  email: z.string().trim().email("Formato de correo electrónico inválido").optional().nullable().or(z.literal("")),
  address: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  tagIds: z.array(z.string().uuid()).optional(),
});

const updateCustomerSchema = z.object({
  fullName: z.string().trim().min(1).optional(),
  waPhone: z.string().trim().min(6).optional(),
  nationalId: z.string().trim().optional().nullable(),
  email: z.string().trim().email("Formato de correo electrónico inválido").optional().nullable().or(z.literal("")),
  address: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  tagIds: z.array(z.string().uuid()).optional(),
});

const syncIspSchema = z.object({
  nationalId: z.string().trim().optional(),
});

export function createCustomersRouter(deps: CustomersRouterDeps): Router {
  const router = Router();

  /**
   * GET /api/customers
   * Lista paginada de contactos con búsqueda, filtro por etiquetas y fechas.
   */
  router.get("/api/customers", async (req, res, next) => {
    try {
      requireAuth(req);
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const tagId = typeof req.query.tagId === "string" ? req.query.tagId : undefined;
      const hasTags =
        req.query.hasTags === "true" ? true : req.query.hasTags === "false" ? false : undefined;
      const startDate = typeof req.query.startDate === "string" ? req.query.startDate : undefined;
      const endDate = typeof req.query.endDate === "string" ? req.query.endDate : undefined;
      const page = req.query.page ? parseInt(String(req.query.page), 10) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;

      const result = await deps.listCustomers.execute({
        search,
        tagId,
        hasTags,
        startDate,
        endDate,
        page,
        limit,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/customers/:id
   * Detalle completo de un contacto por ID.
   */
  router.get("/api/customers/:id", async (req, res, next) => {
    try {
      requireAuth(req);
      const customer = await deps.getCustomer.execute(req.params.id);
      res.json({ data: customer });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/customers
   * Registra un nuevo contacto.
   */
  router.post("/api/customers", async (req, res, next) => {
    try {
      requireAuth(req);
      const parsed = createCustomerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }

      const cleanEmail = parsed.data.email === "" ? null : parsed.data.email;
      const customer = await deps.createCustomer.execute({
        ...parsed.data,
        email: cleanEmail,
      });

      res.status(201).json({ data: customer });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PATCH /api/customers/:id
   * Actualiza datos de un contacto o sus etiquetas asociadas.
   */
  router.patch("/api/customers/:id", async (req, res, next) => {
    try {
      requireAuth(req);
      const parsed = updateCustomerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }

      const cleanEmail = parsed.data.email === "" ? null : parsed.data.email;
      const customer = await deps.updateCustomer.execute(req.params.id, {
        ...parsed.data,
        email: cleanEmail,
      });

      res.json({ data: customer });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/customers/:id
   * Elimina un contacto (requiere rol admin o manager).
   */
  router.delete("/api/customers/:id", async (req, res, next) => {
    try {
      requireRole(req, ["admin", "manager"]);
      await deps.deleteCustomer.execute(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/customers/:id/sync-isp
   * Sincroniza datos técnicos y contratos con el ISP vía n8n (VALIDATE_CLIENT) usando la cédula.
   */
  router.post("/api/customers/:id/sync-isp", async (req, res, next) => {
    try {
      requireAuth(req);
      const parsed = syncIspSchema.safeParse(req.body);
      if (!parsed.success) {
        throw validationError(parsed.error.issues.map((i) => i.message).join(", "));
      }

      const result = await deps.syncCustomerIsp.execute({
        customerId: req.params.id,
        nationalId: parsed.data.nationalId,
      });

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
