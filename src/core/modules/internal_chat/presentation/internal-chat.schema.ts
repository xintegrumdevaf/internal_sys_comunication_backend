import { z } from "zod";

export const createDirectThreadSchema = z.object({
  peerAgentId: z.string().uuid("El ID del agente destinatario debe ser un UUID valido"),
  referenceId: z.string().uuid("El referenceId debe ser un UUID valido").nullable().optional(),
});

export const sendInternalMessageSchema = z.object({
  body: z.string().min(1, "El mensaje no puede estar vacio"),
  type: z.enum(["text", "quality_quote", "conversation_excerpt"]).optional().default("text"),
  contextData: z.record(z.string(), z.unknown()).optional().default({}),
});

export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
});
