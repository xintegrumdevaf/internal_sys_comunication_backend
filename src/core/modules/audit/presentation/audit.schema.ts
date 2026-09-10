import { z } from "zod";

export const listAuditQuerySchema = z.object({
  action: z.string().optional(),
  category: z.enum(["security", "operational", "data_change", "system"]).optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  actorId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
});

export const auditStatsQuerySchema = z.object({
  departmentId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
