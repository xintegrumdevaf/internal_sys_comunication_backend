import type { Logger } from "../../../../../shared/logging/logger";
import type { TelegramGatewayPort } from "../ports/telegram-gateway.port";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import type {
  TelegramAlertPayload,
  TelegramInlineKeyboard,
  TelegramMessageResult,
} from "../../domain/telegram-message.types";

export interface SendTelegramAlertDeps {
  gateway: TelegramGatewayPort;
  getSettings: () => Promise<TelegramSettings>;
  logger: Logger;
}

export class SendTelegramAlertUseCase {
  constructor(private readonly deps: SendTelegramAlertDeps) {}

  async execute(alert: TelegramAlertPayload): Promise<TelegramMessageResult | null> {
    const settings = await this.deps.getSettings();

    if (!settings.enabled || !settings.defaultChatId) {
      this.deps.logger.debug("módulo Telegram deshabilitado o sin defaultChatId configurado; omitiendo alerta");
      return null;
    }

    // Resolver tema (topic) según categoría (temas dinámicos primero, luego legacy)
    let messageThreadId: number | null = null;
    if (settings.topics && settings.topics.length > 0) {
      const dynamicTopic = settings.topics.find((t) => t.category === alert.category && t.enabled);
      if (dynamicTopic) {
        messageThreadId = dynamicTopic.threadId;
      }
    }

    if (messageThreadId === null) {
      if (alert.category === "SLA" && settings.slaTopicId) {
        messageThreadId = settings.slaTopicId;
      } else if (alert.category === "INFRASTRUCTURE" && settings.infraTopicId) {
        messageThreadId = settings.infraTopicId;
      } else if (alert.category === "DIGEST" && settings.digestsTopicId) {
        messageThreadId = settings.digestsTopicId;
      }
    }

    // Emoji de severidad
    const icon = alert.severity === "CRITICAL" ? "🚨" : alert.severity === "WARNING" ? "⚠️" : "ℹ️";
    const headerPrefix = alert.severity === "CRITICAL" ? "<b>[CRÍTICO]</b> " : alert.severity === "WARNING" ? "<b>[ALERTA]</b> " : "";

    const lines: string[] = [
      `${icon} ${headerPrefix}<b>${escapeHtml(alert.title)}</b>`,
      "",
      escapeHtml(alert.body),
    ];

    if (alert.metadata && Object.keys(alert.metadata).length > 0) {
      lines.push("");
      for (const [k, v] of Object.entries(alert.metadata)) {
        if (v !== undefined && v !== null) {
          lines.push(`• <b>${escapeHtml(k)}:</b> <code>${escapeHtml(String(v))}</code>`);
        }
      }
    }

    const replyMarkup: TelegramInlineKeyboard | undefined =
      alert.actions && alert.actions.length > 0
        ? {
            inline_keyboard: [
              alert.actions.map((act) => ({
                text: act.label,
                url: act.url,
                callback_data: act.callbackData,
              })),
            ],
          }
        : undefined;

    const result = await this.deps.gateway.sendMessage({
      chatId: settings.defaultChatId,
      messageThreadId,
      text: lines.join("\n"),
      parseMode: "HTML",
      replyMarkup,
      disableNotification: alert.severity === "INFO",
    });

    this.deps.logger.info(
      { category: alert.category, severity: alert.severity, messageId: result.messageId },
      "alerta enviada a Telegram exitosamente",
    );

    return result;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

