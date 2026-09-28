import type { Logger } from "../../../../../shared/logging/logger";
import type { CaseRepositoryPort } from "../ports/case.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";
import type { CaseSchedulingMetadata } from "../../domain/contexts/case-context";

export class ScheduledReminderNotifierService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      caseRepo: CaseRepositoryPort;
      broadcaster: RealtimeBroadcaster;
      logger: Logger;
      checkIntervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.checkIntervalMs ?? 30000; // default 30 segundos
    this.timer = setInterval(() => {
      void this.checkScheduledReminders().catch((err) => {
        this.deps.logger.error({ err }, "error revisando recordatorios de casos agendados");
      });
    }, interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkScheduledReminders(): Promise<number> {
    const now = new Date();
    const expiringCases = await this.deps.caseRepo.listAutomatableExpiring(now);
    let notifiedCount = 0;

    for (const c of expiringCases) {
      const metadata = c.context?.schedulingMetadata;

      if (!metadata || !metadata.scheduledAt || metadata.notifiedAt) {
        continue;
      }

      const scheduledDate = new Date(metadata.scheduledAt);
      if (scheduledDate.getTime() <= now.getTime()) {
        const updatedMetadata = {
          ...metadata,
          notifiedAt: now.toISOString(),
        };

        const updatedContext = {
          ...c.context,
          schedulingMetadata: updatedMetadata,
        };

        const aggregate = await this.deps.caseRepo.findById(c.id);
        if (!aggregate) continue;

        await this.deps.caseRepo.applyTransition({
          caseId: c.id,
          expectedCaseVersion: aggregate.case.version,
          expectedWorkflowVersion: aggregate.workflowInstance.version,
          status: aggregate.case.status,
          context: updatedContext,
          currentState: aggregate.workflowInstance.currentState,
          expiresAt: aggregate.case.expiresAt,
        });

        this.deps.broadcaster.publish({
          type: "CASE_SCHEDULED_REMINDER",
          caseId: c.id,
          conversationId: c.conversationId,
          assignedAgentId: c.assignedAgentId,
          departmentId: c.departmentId,
          scheduledAt: metadata.scheduledAt,
          scheduleTag: metadata.scheduleTag,
          reminderReason: metadata.reminderReason ?? undefined,
        });

        await this.deps.caseRepo.appendEvent(c.id, "CASE_SCHEDULED_REMINDER_TRIGGERED", {
          scheduledAt: metadata.scheduledAt,
          notifiedAt: now.toISOString(),
        });

        notifiedCount++;
        this.deps.logger.info(
          { caseId: c.id, scheduledAt: metadata.scheduledAt },
          "alerta interna de recordatorio agendado emitida a los agentes",
        );
      }
    }

    return notifiedCount;
  }
}
