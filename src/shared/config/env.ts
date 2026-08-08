import "dotenv/config";
import { z } from "zod";

/**
 * Esquema de variables de entorno (docs/spec/05_BUILD_PLAN.md - Etapa 0).
 * Falla rapido al arrancar si falta o es invalida una variable requerida,
 * en vez de fallar mas tarde en un punto arbitrario del codigo.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_PUBLIC_URL: z.string().min(1, "APP_PUBLIC_URL es requerida"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL es requerida"),
  REDIS_URL: z.string().min(1, "REDIS_URL es requerida"),

  API_INTERNAL_KEY: z.string().min(1, "API_INTERNAL_KEY es requerida"),

  WHATSAPP_APP_SECRET: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),

  // Registro de acciones -> URL (docs/spec/04_N8N_WORKFLOW_SPEC.md §7): un
  // workflow independiente por accion, cada uno Webhook -> Respond to Webhook.
  // Se consumen recien en la Etapa 3 (N8nGatewayPort); aqui solo se validan.
  N8N_WEBHOOK_INTERPRET_MESSAGE: z.string().min(1, "N8N_WEBHOOK_INTERPRET_MESSAGE es requerida"),
  N8N_WEBHOOK_VALIDATE_CLIENT: z.string().min(1, "N8N_WEBHOOK_VALIDATE_CLIENT es requerida"),
  N8N_WEBHOOK_CHECK_BALANCE: z.string().min(1, "N8N_WEBHOOK_CHECK_BALANCE es requerida"),
  N8N_WEBHOOK_DIAGNOSTIC: z.string().min(1, "N8N_WEBHOOK_DIAGNOSTIC es requerida"),
  N8N_WEBHOOK_CONTINUE_DIAGNOSTIC: z.string().min(1, "N8N_WEBHOOK_CONTINUE_DIAGNOSTIC es requerida"),
  N8N_WEBHOOK_RECORD_PAYMENT: z.string().min(1, "N8N_WEBHOOK_RECORD_PAYMENT es requerida"),
  N8N_WEBHOOK_APPLY_BANK_ACCOUNT: z.string().min(1, "N8N_WEBHOOK_APPLY_BANK_ACCOUNT es requerida"),

  N8N_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  N8N_CALL_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuracion de entorno invalida:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
