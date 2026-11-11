import type { Logger } from "../../../../../shared/logging/logger";
import type { AnalyticsRepositoryPort } from "../../../analytics/application/ports/analytics.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { TelegramGatewayPort } from "../ports/telegram-gateway.port";
import type { SendTelegramDigestUseCase } from "./send-telegram-digest.use-case";
import type { AnswerTelegramCopilotQuestionUseCase } from "./answer-telegram-copilot-question.use-case";
import type { TelegramSettings } from "../../domain/telegram-config.entity";
import type {
  TelegramInlineKeyboard,
  TelegramUpdate,
} from "../../domain/telegram-message.types";

export interface HandleTelegramWebhookDeps {
  gateway: TelegramGatewayPort;
  getSettings: () => Promise<TelegramSettings>;
  caseRepo: CaseRepositoryPort;
  agentRepo: AgentRepositoryPort;
  analyticsRepo: AnalyticsRepositoryPort;
  sendTelegramDigest: SendTelegramDigestUseCase;
  answerCopilotQuestion?: AnswerTelegramCopilotQuestionUseCase;
  appPublicUrl: string;
  frontendUrl?: string;
  logger: Logger;
}

export interface HandleWebhookInput {
  update: TelegramUpdate;
  secretTokenHeader?: string;
}

export interface HandleWebhookResult {
  handled: boolean;
  command?: string;
  reason?: string;
}

export class HandleTelegramWebhookUseCase {
  constructor(private readonly deps: HandleTelegramWebhookDeps) {}

  async execute(input: HandleWebhookInput): Promise<HandleWebhookResult> {
    const { update, secretTokenHeader } = input;
    const settings = await this.deps.getSettings();

    // 1. Validar que la interacción de comandos o copilot esté habilitada
    const hasInteractive = Boolean(settings.commandsEnabled || settings.aiCopilotEnabled);
    if (!hasInteractive) {
      this.deps.logger.debug("comandos interactivos y copilot de Telegram deshabilitados");
      return { handled: false, reason: "disabled" };
    }

    // 2. Validar secreto de webhook si está configurado
    if (settings.webhookSecret && settings.webhookSecret.trim() !== "") {
      if (secretTokenHeader !== settings.webhookSecret.trim()) {
        this.deps.logger.warn("solicitud de webhook de Telegram con secreto inválido o ausente");
        return { handled: false, reason: "invalid_secret" };
      }
    }

    // 3. Determinar el contexto del mensaje o callback query
    const message = update.message;
    const callbackQuery = update.callback_query;

    const chatId = String(message?.chat?.id ?? callbackQuery?.message?.chat?.id ?? "");
    const messageThreadId = message?.message_thread_id ?? callbackQuery?.message?.message_thread_id;

    if (!chatId) {
      return { handled: false, reason: "missing_chat_id" };
    }

    // 4. Validar lista blanca de chats autorizados (tolerante a prefijo de supergrupo -100)
    if (settings.defaultChatId && String(settings.defaultChatId).trim() !== "") {
      const allowedChatId = String(settings.defaultChatId).trim();
      const normalize = (id: string) => id.replace(/^-100/, "-");
      if (chatId !== allowedChatId && normalize(chatId) !== normalize(allowedChatId)) {
        this.deps.logger.warn({ chatId, allowedChatId }, "mensaje de Telegram ignorado: chat no autorizado");
        return { handled: false, reason: "unauthorized_chat" };
      }
    }

    // 5. Procesar Callback Query (botones interactivos en línea)
    if (callbackQuery) {
      await this.deps.gateway.answerCallbackQuery(
        {
          callbackQueryId: callbackQuery.id,
          text: "Procesando consulta...",
        },
        settings.botToken,
      );

      const data = callbackQuery.data ?? "";
      if (data.startsWith("cmd:")) {
        if (!settings.commandsEnabled) {
          return { handled: false, reason: "disabled" };
        }
        const cmdName = data.slice(4);
        await this.dispatchCommand(cmdName, chatId, messageThreadId, settings);
        return { handled: true, command: cmdName };
      }

      return { handled: true, command: "callback" };
    }

    // 6. Procesar Mensaje de Texto (comandos /resumen, /sla, /agentes, o Copilot con IA)
    if (message?.text) {
      const rawText = message.text.trim();
      // Limpiar mención al bot al inicio si fue arrobado en un grupo (ej: "@CentinelaIsp_bot cómo venimos hoy?" -> "cómo venimos hoy?")
      const cleanText = rawText.replace(/^@\w+[\s:,]*/i, "").trim();

      if (cleanText.startsWith("/")) {
        if (!settings.commandsEnabled) {
          return { handled: false, reason: "disabled" };
        }

        // Extraer comando ignorando mención de bot (ej. /sla@MiIspBot -> sla)
        const parts = cleanText.slice(1).split(" ");
        const firstToken = parts[0] || "";
        const commandName = firstToken.split("@")[0]?.toLowerCase() || "";

        await this.dispatchCommand(commandName, chatId, messageThreadId, settings);
        return { handled: true, command: commandName };
      }

      // Si no es un comando con '/', pero el Copilot con IA está habilitado
      if (settings.aiCopilotEnabled && this.deps.answerCopilotQuestion) {
        await this.deps.answerCopilotQuestion.execute({
          question: cleanText,
          chatId,
          messageThreadId,
        });
        return { handled: true, command: "ai_copilot" };
      }
    }

    return { handled: false, reason: "ignored_update" };
  }

  private async dispatchCommand(
    command: string,
    chatId: string,
    messageThreadId: number | undefined,
    settings: TelegramSettings,
  ): Promise<void> {
    switch (command) {
      case "resumen":
      case "pulso": {
        await this.deps.sendTelegramDigest.execute({
          forced: true,
          timeLabel: "Solicitado en Chat",
        });
        break;
      }

      case "sla": {
        await this.handleSlaCommand(chatId, messageThreadId, settings);
        break;
      }

      case "agentes": {
        await this.handleAgentsCommand(chatId, messageThreadId, settings);
        break;
      }

      case "infra":
      case "red": {
        await this.handleInfraCommand(chatId, messageThreadId, settings);
        break;
      }

      case "ayuda":
      case "help":
      case "start":
      default: {
        await this.handleHelpCommand(chatId, messageThreadId, settings);
        break;
      }
    }
  }

  private async handleSlaCommand(
    chatId: string,
    messageThreadId: number | undefined,
    settings: TelegramSettings,
  ): Promise<void> {
    const thresholdMinutes = settings.slaThresholdMinutes || 15;
    let unattendedCases: Array<{
      caseId: string;
      customerName: string;
      customerPhone: string;
      assignedAgentName?: string | null;
      departmentName?: string | null;
      waitMinutes: number;
    }> = [];

    if (this.deps.caseRepo.findUnattendedHumanCases) {
      unattendedCases = await this.deps.caseRepo.findUnattendedHumanCases(thresholdMinutes, 10);
    }

    if (unattendedCases.length === 0) {
      const text = [
        "✅ <b>SLA BAJO CONTROL</b>",
        `No se registran casos de atención humana que superen los <b>${thresholdMinutes} min</b> de espera sin respuesta.`,
        "<i>Todos los clientes están siendo atendidos dentro de la ventana de servicio.</i>",
      ].join("\n");

      await this.deps.gateway.sendMessage(
        {
          chatId,
          messageThreadId,
          text,
          replyMarkup: this.buildQuickButtons(),
        },
        settings.botToken,
      );
      return;
    }

    const lines: string[] = [
      `🚨 <b>BRECHAS DE SLA EN ATENCIÓN HUMANA (&gt; ${thresholdMinutes} min)</b>`,
      `Detectados <b>${unattendedCases.length} caso(s)</b> demorados:`,
      "",
    ];

    for (const c of unattendedCases) {
      const agent = c.assignedAgentName ? `👤 ${escapeHtml(c.assignedAgentName)}` : "⚠️ <i>Sin asignar</i>";
      const dept = c.departmentName ? ` | ${escapeHtml(c.departmentName)}` : "";
      lines.push(
        `• <b>${escapeHtml(c.customerName)}</b> (${c.customerPhone})`,
      );
      lines.push(
        `  ⏱️ <code>${Math.round(c.waitMinutes)} min en espera</code> | ${agent}${dept}`,
      );
    }

    const effectiveFrontendUrl = (
      (settings.frontendUrl && settings.frontendUrl.trim() !== "")
        ? settings.frontendUrl.trim()
        : (this.deps.frontendUrl || "http://localhost:8080")
    ).replace(/\/$/, "");

    const replyMarkup: TelegramInlineKeyboard = {
      inline_keyboard: [
        [{ text: "📂 Abrir Bandeja de Casos", url: `${effectiveFrontendUrl}/bandeja` }],
        ...this.buildQuickButtons().inline_keyboard,
      ],
    };

    await this.deps.gateway.sendMessage(
      {
        chatId,
        messageThreadId,
        text: lines.join("\n"),
        replyMarkup,
      },
      settings.botToken,
    );
  }

  private async handleAgentsCommand(
    chatId: string,
    messageThreadId: number | undefined,
    settings: TelegramSettings,
  ): Promise<void> {
    const allAgents = await this.deps.agentRepo.list();
    const activeAgents = allAgents.filter((a) => a.active);

    const lines: string[] = [
      "👥 <b>ESTADO DE ASESORES EN TURNO</b>",
      `Total asesores activos en el sistema: <b>${activeAgents.length}</b>`,
      "",
    ];

    if (activeAgents.length === 0) {
      lines.push("⚠️ <i>No hay asesores con turno activo en este momento.</i>");
    } else {
      for (const agent of activeAgents) {
        const statusBadge = agent.autoAssignEnabled ? "🟢 Asignación activa" : "🟡 Asignación pausada";
        lines.push(
          `• <b>${escapeHtml(agent.name)}</b> (<i>${escapeHtml(agent.role)}</i>) - ${statusBadge}`,
        );
      }
    }

    await this.deps.gateway.sendMessage(
      {
        chatId,
        messageThreadId,
        text: lines.join("\n"),
        replyMarkup: this.buildQuickButtons(),
      },
      settings.botToken,
    );
  }

  private async handleInfraCommand(
    chatId: string,
    messageThreadId: number | undefined,
    settings: TelegramSettings,
  ): Promise<void> {
    const minCases = settings.infraAlertMinCases || 3;
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const rawAlerts = await this.deps.analyticsRepo.getInfrastructureAlerts({
      from: twoHoursAgo,
      to: now,
    });
    const alerts = rawAlerts.filter((a) => a.activeCasesCount >= minCases);

    if (alerts.length === 0) {
      const text = [
        "🌐 <b>RED E INFRAESTRUCTURA OPERATIVA</b>",
        `No se detectan concentraciones de fallas o cortes masivos (&ge; ${minCases} casos) en ninguna OLT o sector.`,
      ].join("\n");

      await this.deps.gateway.sendMessage(
        {
          chatId,
          messageThreadId,
          text,
          replyMarkup: this.buildQuickButtons(),
        },
        settings.botToken,
      );
      return;
    }

    const lines: string[] = [
      "⚠️ <b>ALERTAS DE INFRAESTRUCTURA / RED</b>",
      `Detectada(s) <b>${alerts.length} zona(s)</b> con concentración anómala de reclamos:`,
      "",
    ];

    for (const a of alerts) {
      const olt = a.oltName ? ` | OLT: <b>${escapeHtml(a.oltName)}</b>` : "";
      const tag = a.isHighVolumeAlert ? "🚨 <i>Corte Masivo Probable</i>" : "⚠️ <i>Incidencia Zonal</i>";
      lines.push(`• <b>Sector:</b> ${escapeHtml(a.sector)}${olt}`);
      lines.push(`  <b>Casos activos:</b> <code>${a.activeCasesCount}</code> | ${tag}`);
    }

    await this.deps.gateway.sendMessage(
      {
        chatId,
        messageThreadId,
        text: lines.join("\n"),
        replyMarkup: this.buildQuickButtons(),
      },
      settings.botToken,
    );
  }

  private async handleHelpCommand(
    chatId: string,
    messageThreadId: number | undefined,
    settings: TelegramSettings,
  ): Promise<void> {
    const text = [
      "🤖 <b>CENTINELA OPERATIVO - COMANDOS EJECUTIVOS</b>",
      "",
      "Comandos disponibles para supervisión directa:",
      "• <code>/resumen</code> - Pulso operativo y KPIs consolidados del día.",
      "• <code>/sla</code> - Lista casos con demoras críticas en atención humana.",
      "• <code>/agentes</code> - Personal en turno y estado de asignación.",
      "• <code>/infra</code> - Detección de fallas masivas por OLT o sector.",
      "• <code>/ayuda</code> - Muestra este panel de instrucciones.",
      "",
      "<i>También podés interactuar tocando los botones a continuación:</i>",
    ].join("\n");

    await this.deps.gateway.sendMessage(
      {
        chatId,
        messageThreadId,
        text,
        replyMarkup: this.buildQuickButtons(),
      },
      settings.botToken,
    );
  }

  private buildQuickButtons(): TelegramInlineKeyboard {
    return {
      inline_keyboard: [
        [
          { text: "📊 Resumen", callback_data: "cmd:resumen" },
          { text: "⏱️ SLA", callback_data: "cmd:sla" },
        ],
        [
          { text: "👥 Asesores", callback_data: "cmd:agentes" },
          { text: "🌐 Infraestructura", callback_data: "cmd:infra" },
        ],
      ],
    };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
