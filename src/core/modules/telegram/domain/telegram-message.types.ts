/**
 * Botones interactivos en línea de Telegram (Inline Keyboard).
 */
export type TelegramInlineButton = {
  text: string;
  url?: string;
  callback_data?: string;
};

export type TelegramInlineKeyboard = {
  inline_keyboard: TelegramInlineButton[][];
};

/**
 * Severidad de las alertas operativas.
 */
export type TelegramAlertSeverity = "INFO" | "WARNING" | "CRITICAL";

/**
 * Categorías de alertas que pueden enrutarse a topics separados.
 */
export type TelegramAlertCategory = "SLA" | "INFRASTRUCTURE" | "QUEUE" | "QUALITY" | "DIGEST" | "SYSTEM";

/**
 * Parámetros para emitir un mensaje o alerta a Telegram.
 */
export interface SendTelegramMessageInput {
  chatId?: string;
  messageThreadId?: number | null;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  replyMarkup?: TelegramInlineKeyboard;
  disableNotification?: boolean;
}

/**
 * Estructura de alerta enriquecida para el despachador.
 */
export interface TelegramAlertPayload {
  category: TelegramAlertCategory;
  severity: TelegramAlertSeverity;
  title: string;
  body: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  actions?: Array<{ label: string; url?: string; callbackData?: string }>;
}

/**
 * Respuesta genérica de la API oficial de Telegram.
 */
export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/**
 * Información básica del bot obtenida mediante getMe.
 */
export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

/**
 * Resultado de envío de mensaje.
 */
export interface TelegramMessageResult {
  ok: boolean;
  messageId: number;
  chatId: string | number;
  date: number;
}

