import { z } from "zod";

/**
 * Enmascara valores confidenciales (tokens, api keys, secrets) para no exponerlos
 * en texto plano al frontend. Muestra solo los últimos 4 caracteres.
 */
export function maskSecret(value?: string | null): string {
  if (!value || typeof value !== "string" || value.trim() === "") {
    return "";
  }
  const clean = value.trim();
  if (clean.length <= 4) {
    return "••••••••";
  }
  const last4 = clean.slice(-4);
  return `••••••••••••${last4}`;
}

/**
 * Verifica si un valor enviado desde el frontend es un marcador enmascarado.
 */
export function isMaskedValue(value?: string | null): boolean {
  if (!value || typeof value !== "string") return false;
  return value.includes("••••") || value.includes("****");
}

/**
 * Combina un valor secreto nuevo con el preexistente:
 * Si el nuevo está vacío o enmascarado, preserva el secreto preexistente.
 */
export function mergeSecret(incoming?: string | null, existing?: string | null): string {
  if (!incoming || incoming.trim() === "" || isMaskedValue(incoming)) {
    return existing ?? "";
  }
  return incoming.trim();
}

/**
 * Esquema de configuración de canales de mensajería (WhatsApp Meta / Zernio).
 */
export const WhatsAppChannelSettingsSchema = z.object({
  provider: z.enum(["meta", "zernio"]).default("meta"),
  // Meta Cloud API
  phoneNumberId: z.string().default(""),
  wabaId: z.string().default(""),
  accessToken: z.string().default(""),
  appSecret: z.string().default(""),
  verifyToken: z.string().default(""),
  // Zernio API
  zernioApiKey: z.string().default(""),
  zernioAccountId: z.string().default(""),
  zernioWebhookSecret: z.string().default(""),
  zernioBaseUrl: z.string().default("https://zernio.com/api/v1"),
});

export type WhatsAppChannelSettings = z.infer<typeof WhatsAppChannelSettingsSchema>;

/**
 * Esquema de configuración de proveedores de IA y modelos dinámicos.
 */
export const AiProviderSettingsSchema = z.object({
  provider: z.enum(["ollama", "gemini"]).default("gemini"),
  // Gemini
  geminiApiKey: z.string().default(""),
  geminiModel: z.string().default("gemini-2.5-flash"),
  geminiEmbeddingModel: z.string().default("text-embedding-004"),
  geminiEmbeddingDimension: z.number().int().positive().default(768),
  // Ollama
  ollamaBaseUrl: z.string().default("http://localhost:11434"),
  ollamaModel: z.string().default("qwen3.5:4b"),
  ollamaEmbeddingModel: z.string().default("qwen3-embedding:4b"),
  ollamaEmbeddingDimension: z.number().int().positive().default(2560),
  // Parámetros operativos
  aiCallTimeoutMs: z.number().int().positive().default(45000),
  aiQualityTimeoutMs: z.number().int().positive().default(600000),
});

export type AiProviderSettings = z.infer<typeof AiProviderSettingsSchema>;

/**
 * Estado general del setup para el onboarding inicial en frontend.
 */
export interface SystemSetupStatus {
  isChannelConfigured: boolean;
  isAiConfigured: boolean;
  hasDepartments: boolean;
  hasAgents: boolean;
  isInitialSetupComplete: boolean;
  activeChannelProvider: "meta" | "zernio";
  activeAiProvider: "ollama" | "gemini";
}
