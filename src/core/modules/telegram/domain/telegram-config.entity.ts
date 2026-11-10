import { z } from "zod";
import { isMaskedValue } from "../../settings/domain/system-settings.entity";

/**
 * Esquema de configuración de alertas e integración con Telegram Bot API.
 */
export const TelegramSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(""),
  defaultChatId: z.string().default(""), // ID del supergrupo o canal directivo
  // Temas (Forum Topics) opcionales dentro del supergrupo (message_thread_id)
  slaTopicId: z.number().int().positive().nullable().optional().default(null),
  infraTopicId: z.number().int().positive().nullable().optional().default(null),
  digestsTopicId: z.number().int().positive().nullable().optional().default(null),
  // Pulso programado (Digests)
  digestsEnabled: z.boolean().default(true),
  digestHours: z.array(z.string().regex(/^\d{2}:\d{2}$/)).default(["09:00", "14:00", "19:00"]),
  timeZone: z.string().default("America/Guayaquil"),
  // Umbrales de alertas reactivas
  slaThresholdMinutes: z.number().int().min(5).max(120).default(15),
  infraAlertMinCases: z.number().int().min(2).max(10).default(3),
  queueSaturationThreshold: z.number().int().min(3).max(50).default(10),
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

