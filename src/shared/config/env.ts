import dotenv from "dotenv";
dotenv.config({ override: true });
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

  // CORS para el frontend (docs/API_ENDPOINTS.md - consumido desde el navegador).
  // Lista separada por comas (ej. "http://localhost:8080,http://localhost:8082").
  // Vacio + NODE_ENV=development => refleja cualquier origin (conveniencia local,
  // nunca en produccion). Vacio + NODE_ENV=production => no se permite ningun
  // origin (falla explicito en vez de abrir CORS por accidente).
  CORS_ALLOWED_ORIGINS: z.string().default(""),

  // Login real (docs/spec/06_BACKEND_GAPS.md Â§1.b): sesion con cookie httpOnly
  // + Redis, expiracion deslizante (se renueva en cada request autenticado;
  // se cierra sola tras N segundos de inactividad). 43200s = 12h.
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43200),

  WHATSAPP_APP_SECRET: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  META_WABA_ID: z.string().default(""),
  META_ACCESS_TOKEN: z.string().default(""),

  // AIProviderPort (docs/spec/03_API_CONTRACT.md Â§A)
  AI_PROVIDER: z.enum(["ollama", "gemini"]).default("ollama"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("qwen3.5:4b"),
  OLLAMA_EMBEDDING_MODEL: z.string().default("qwen3-embedding:4b"),
  OLLAMA_EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(2560),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash-lite"),
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-2"),
  GEMINI_EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(768),
  AI_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  /** Timeout para analyzeAgentConversation (Ollama local puede tardar varios minutos). */
  AI_QUALITY_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  /** TamaÃ±o de tramo (mensajes customer+agent) por llamada a la IA de calidad. */
  QUALITY_ANALYSIS_CHUNK_SIZE: z.coerce.number().int().min(10).max(80).default(40),

  // Buffer/debounce de mensajes por conversacion (docs/spec/02_STATE_MACHINE.md Â§12).
  MESSAGE_DEBOUNCE_MS: z.coerce.number().int().positive().default(4500),

  // Auto-asignacion de casos escalados (docs/spec/06_BACKEND_GAPS.md Â§2):
  // umbral de casos HUMAN_ACTIVE por agente antes de excluirlo de la seleccion
  // automatica (sigue disponible para asignacion manual por un manager).
  AUTO_ASSIGN_MAX_ACTIVE_CASES_PER_AGENT: z.coerce.number().int().positive().default(6),

  // El registro de accion -> URL de n8n vive en la tabla n8n_workflow_registry
  // (docs/spec/01_DATA_MODEL.md §2, v3) — aqui solo quedan defaults globales,
  // el timeout/retries por accion especifica se puede sobreescribir en la fila.
  N8N_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  N8N_CALL_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),

  // Microservicio de diagnostico MikroTik/OLT directo (sin pasar por n8n)
  MIKROTIK_SERVICE_URL: z.string().default("http://localhost:3001/api"),
  MIKROTIK_DIAGNOSTIC_TIMEOUT_MS: z.coerce.number().int().positive().default(35000),
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

