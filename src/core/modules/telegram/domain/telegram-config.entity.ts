import { z } from "zod";
import { isMaskedValue } from "../../settings/domain/system-settings.entity";

/**
 * Categorías admitidas para enrutamiento de temas (Forum Topics) en Telegram.
 */
export const TelegramTopicCategorySchema = z.enum([
  "SLA",
  "INFRASTRUCTURE",
  "DIGEST",
  "QUEUE",
  "QUALITY",
  "GENERAL",
]);
export type TelegramTopicCategory = z.infer<typeof TelegramTopicCategorySchema>;

/**
 * Esquema de configuración de un Tema (Forum Topic) dinámico dentro del supergrupo.
 */
export const TelegramTopicSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: TelegramTopicCategorySchema,
  threadId: z.number().int().positive(),
  enabled: z.boolean().default(true),
});
export type TelegramTopicConfig = z.infer<typeof TelegramTopicSchema>;

/**
 * Categorías de reglas evaluadas por el Centinela reactivo.
 */
export const TelegramAlertRuleCategorySchema = z.enum(["SLA", "INFRASTRUCTURE", "QUEUE"]);
export type TelegramAlertRuleCategory = z.infer<typeof TelegramAlertRuleCategorySchema>;

/**
 * Esquema de configuración de una Regla dinámica de alerta del Centinela.
 */
export const TelegramAlertRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: TelegramAlertRuleCategorySchema,
  threshold: z.number().int().min(1),
  unit: z.string().default(""),
  severity: z.enum(["CRITICAL", "WARNING", "INFO"]).default("CRITICAL"),
  enabled: z.boolean().default(true),
  description: z.string().default(""),
});
export type TelegramAlertRuleConfig = z.infer<typeof TelegramAlertRuleSchema>;

export const DEFAULT_TELEGRAM_TOPICS: TelegramTopicConfig[] = [
  { id: "topic-sla", name: "Alertas de SLA & Demoras", category: "SLA", threadId: 10, enabled: true },
  { id: "topic-infra", name: "Infraestructura & Fibra / OLT", category: "INFRASTRUCTURE", threadId: 20, enabled: true },
  { id: "topic-digests", name: "Pulso Operativo Ejecutivo", category: "DIGEST", threadId: 30, enabled: true },
];

export const DEFAULT_TELEGRAM_ALERT_RULES: TelegramAlertRuleConfig[] = [
  {
    id: "rule-sla-delay",
    name: "Demora Crítica en Atención Humana",
    category: "SLA",
    threshold: 15,
    unit: "minutos",
    severity: "CRITICAL",
    enabled: true,
    description: "Alerta roja si un cliente asignado a un asesor supera este tiempo sin respuesta.",
  },
  {
    id: "rule-infra-outage",
    name: "Corte Masivo o Falla de Sector (OLT)",
    category: "INFRASTRUCTURE",
    threshold: 3,
    unit: "reclamos",
    severity: "CRITICAL",
    enabled: true,
    description: "Dispara aviso urgente si varios clientes del mismo sector reportan fallas en los últimos 30m.",
  },
  {
    id: "rule-queue-overflow",
    name: "Saturación de Cola de Espera",
    category: "QUEUE",
    threshold: 10,
    unit: "casos en cola",
    severity: "WARNING",
    enabled: true,
    description: "Avisa si la cola de espera de cualquier departamento supera este volumen sin agentes libres.",
  },
];

/**
 * Esquema de configuración de alertas e integración con Telegram Bot API.
 */
export const TelegramSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(""),
  defaultChatId: z.string().default(""), // ID del supergrupo o canal directivo

  // Switch maestro para habilitar enrutamiento por hilos (Forum Topics de Supergrupo)
  topicsEnabled: z.boolean().default(false),
  // Temas dinámicos (Forum Topics)
  topics: z.array(TelegramTopicSchema).default(DEFAULT_TELEGRAM_TOPICS),

  // Temas (Forum Topics) legacy preservados para retrocompatibilidad
  slaTopicId: z.number().int().positive().nullable().optional().default(null),
  infraTopicId: z.number().int().positive().nullable().optional().default(null),
  digestsTopicId: z.number().int().positive().nullable().optional().default(null),

  // Pulso programado (Digests)
  digestsEnabled: z.boolean().default(true),
  digestHours: z.array(z.string().regex(/^\d{2}:\d{2}$/)).default(["09:00", "14:00", "19:00"]),
  timeZone: z.string().default("America/Guayaquil"),

  // Reglas dinámicas del Centinela Reactivo
  alertRules: z.array(TelegramAlertRuleSchema).default(DEFAULT_TELEGRAM_ALERT_RULES),

  // Umbrales de alertas legacy preservados para retrocompatibilidad
  slaThresholdMinutes: z.number().int().min(5).max(120).default(15),
  infraAlertMinCases: z.number().int().min(2).max(10).default(3),
  queueSaturationThreshold: z.number().int().min(3).max(50).default(10),

  // Webhook y comandos interactivos (/resumen, /sla, /agentes)
  webhookSecret: z.string().default(""),
  commandsEnabled: z.boolean().default(true),

  // Copilot con IA en grupo (consultas en lenguaje natural)
  aiCopilotEnabled: z.boolean().default(false),
});

export type TelegramSettings = z.infer<typeof TelegramSettingsSchema>;

/**
 * Enmascara el token del bot de Telegram preservando solo los últimos 4 caracteres.
 */
export function maskTelegramToken(token?: string | null): string {
  if (!token || typeof token !== "string" || token.trim() === "") {
    return "";
  }
  const clean = token.trim();
  if (clean.length <= 6) {
    return "••••••••";
  }
  const parts = clean.split(":");
  if (parts.length === 2 && parts[0] && parts[1]) {
    const botId = parts[0];
    const secret = parts[1];
    const last4 = secret.slice(-4);
    return `${botId}:••••••••••••${last4}`;
  }
  const last4 = clean.slice(-4);
  return `••••••••••••${last4}`;
}

/**
 * Combina un token entrante con el existente si viene enmascarado.
 */
export function mergeTelegramToken(incoming?: string | null, existing?: string | null): string {
  if (!incoming || incoming.trim() === "" || isMaskedValue(incoming)) {
    return existing ?? "";
  }
  return incoming.trim();
}

