import type { Logger } from "../../../../../shared/logging/logger";
import { TERMINAL_CASE_STATUSES } from "../../domain/case.entity";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { MessageRepositoryPort } from "../../../conversations/application/ports/message.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import { resolveGeneralDepartment } from "../../../departments/application/services/general-department.helper";
import type { EscalationService } from "../../../escalation/application/services/escalation.service";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";
import type { DepartmentResolverService } from "./department-resolver.service";

export type AiWaitingRescueDeps = {
  caseRepo: CaseRepositoryPort;
  conversationRepo: ConversationRepositoryPort;
  escalationService: EscalationService;
  departmentResolver: DepartmentResolverService;
  departmentRepo: DepartmentRepositoryPort;
  messageRepo?: MessageRepositoryPort;
  broadcaster?: RealtimeBroadcaster;
  settingsService?: SystemSettingsService;
  queueOverflowService?: { overflowStaleQueues: (now?: Date) => Promise<number> };
  logger: Logger;
  checkIntervalMs?: number;
};

/**
 * Rescata periódicamente casos que quedaron esperando al cliente con IA
 * (`WAITING_USER`, por defecto >= 45 min) o atascados en `NEW`/`ACTIVE` (>= 5 min)
 * y los escala al departamento correspondiente con auto-asignación a asesor en turno,
 * sin enviar mensajes automáticos molestos al cliente por WhatsApp.
 */
export class AiWaitingRescueService {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(private readonly deps: AiWaitingRescueDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.checkIntervalMs ?? 120_000;
    this.timer = setInterval(() => {
      void this.rescueStaleCases().catch((err) => {
        this.deps.logger.error({ err }, "error en ciclo de rescate de casos en espera con IA");
      });
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async rescueStaleCases(now: Date = new Date()): Promise<number> {
    if (this.isRunning) return 0;
    if (typeof this.deps.caseRepo.listStaleAiCases !== "function") return 0;

    this.isRunning = true;
    let rescuedCount = 0;

    try {
      const thresholds = this.deps.settingsService
        ? await this.deps.settingsService.getAiRescueThresholds()
        : { waitingMinutes: 45, stuckMinutes: 5 };

      const waitingCutoff = new Date(now.getTime() - thresholds.waitingMinutes * 60_000);
      const stuckCutoff = new Date(now.getTime() - thresholds.stuckMinutes * 60_000);

      const candidates = await this.deps.caseRepo.listStaleAiCases({
        waitingCutoff,
        stuckCutoff,
        limit: 25,
      });

      for (const candidate of candidates) {
        try {
          const rescued = await this.rescueSingleCase(candidate.id, thresholds, now);
          if (rescued) rescuedCount += 1;
        } catch (err) {
          this.deps.logger.warn(
            { err, caseId: candidate.id, conversationId: candidate.conversationId },
            "error rescatando caso estancado con IA",
          );
        }
      }

      if (this.deps.queueOverflowService) {
        try {
          await this.deps.queueOverflowService.overflowStaleQueues(now);
        } catch (err) {
          this.deps.logger.warn({ err }, "error en desborde automático de colas sin asesores");
        }
      }

      return rescuedCount;
    } finally {
      this.isRunning = false;
    }
  }

  private async rescueSingleCase(
    caseId: string,
    thresholds: { waitingMinutes: number; stuckMinutes: number },
    now: Date,
  ): Promise<boolean> {
    const aggregate = await this.deps.caseRepo.findById(caseId);
    if (!aggregate) return false;

    const currentCase = aggregate.case;
    if (TERMINAL_CASE_STATUSES.includes(currentCase.status)) return false;
    if (
      currentCase.status === "HUMAN_ACTIVE" ||
      currentCase.status === "ESCALATED" ||
      currentCase.status === "PAUSED"
    ) {
      return false;
    }
    if (currentCase.assignedAgentId !== null) return false;
    if (currentCase.context?.schedulingMetadata?.scheduledAt) return false;

    const autoState = await this.deps.caseRepo.getAutomationState(currentCase.id);
    if (autoState && !autoState.enabled) return false;

    const conv = await this.deps.conversationRepo.findById(currentCase.conversationId);
    if (!conv || conv.status === "resolved" || conv.status === "closed") {
      return false;
    }

    const isStuck = currentCase.status === "NEW" || currentCase.status === "ACTIVE";
    const thresholdMinutes = isStuck ? thresholds.stuckMinutes : thresholds.waitingMinutes;
    const elapsedMinutes = Math.max(
      1,
      Math.round((now.getTime() - currentCase.lastActivityAt.getTime()) / 60_000),
    );
    if (elapsedMinutes < thresholdMinutes) {
      return false;
    }

    let departmentId = currentCase.departmentId;
    if (!departmentId) {
      departmentId = await this.deps.departmentResolver.resolveDepartmentId(
        currentCase.workflowType,
      );
      if (!departmentId) {
        const general = await resolveGeneralDepartment(this.deps.departmentRepo);
        departmentId = general?.id ?? null;
      }
      if (departmentId) {
        await this.deps.caseRepo.applyTransition({
          caseId: currentCase.id,
          expectedCaseVersion: currentCase.version,
          expectedWorkflowVersion: aggregate.workflowInstance.version,
          status: currentCase.status,
          context: currentCase.context,
          currentState: aggregate.workflowInstance.currentState,
          departmentId,
          expiresAt: currentCase.expiresAt,
        });
      }
    }

    const reason = isStuck ? "AI_STUCK_TIMEOUT" : "AI_WAITING_TIMEOUT";
    const escalated = await this.deps.escalationService.escalateExistingCase({
      caseId: currentCase.id,
      reason,
      priority: isStuck ? "high" : "normal",
    });

    if (conv.status !== "open") {
      await this.deps.conversationRepo.setStatus(conv.id, "open");
    }

    const dept = departmentId ? await this.deps.departmentRepo.findById(departmentId) : null;
    const areaLabel = dept?.name ?? "el área correspondiente";
    const systemBody = isStuck
      ? `⏱️ Caso derivado automáticamente a ${areaLabel} por bloqueo en flujo de IA (${elapsedMinutes} min sin avanzar).`
      : `⏱️ Caso derivado automáticamente a ${areaLabel} tras ${elapsedMinutes} min en espera de respuesta con IA.`;

    if (this.deps.messageRepo) {
      const sysMessage = await this.deps.messageRepo.insertOutbound({
        conversationId: conv.id,
        author: "system",
        body: systemBody,
        caseId: escalated.case.id,
        status: "sent",
      });
      this.deps.broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: conv.id,
        messageId: sysMessage.id,
        author: "system",
      });
    }

    await this.deps.caseRepo.appendEvent(currentCase.id, "CASE_AI_TIMEOUT_RESCUED", {
      reason,
      elapsedMinutes,
      thresholdMinutes,
      departmentId,
      assignedAgentId: escalated.case.assignedAgentId,
    });

    this.deps.logger.info(
      {
        caseId: currentCase.id,
        conversationId: conv.id,
        reason,
        elapsedMinutes,
        departmentId,
        assignedAgentId: escalated.case.assignedAgentId,
      },
      "caso rescatado automáticamente desde espera con IA y derivado a atención humana",
    );

    return true;
  }
}
