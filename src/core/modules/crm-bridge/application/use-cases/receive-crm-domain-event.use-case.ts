import { normalizePhoneDigits } from "../../../../../shared/http/crm-signature";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import { TERMINAL_CASE_STATUSES } from "../../../cases/domain/case.entity";
import type { ConversationRepositoryPort } from "../../../conversations/application/ports/conversation.repository.port";
import type { RealtimeBroadcaster } from "../../../realtime/application/realtime-broadcaster";

export interface CrmInboundDomainEventEnvelope {
  eventId?: string;
  eventType?: string;
  aggregateId?: string;
  phone?: string;
  agentName?: string;
  automationEnabled?: boolean;
  payload?: {
    phone?: string;
    prospectId?: string;
    agentName?: string;
    automationEnabled?: boolean;
  };
}

export interface ReceiveCrmDomainEventResult {
  handled: boolean;
  caseId: string | null;
  automationEnabled: boolean | null;
  reason?: string;
}

export interface ReceiveCrmDomainEventDeps {
  conversationRepo: ConversationRepositoryPort;
  caseRepo: CaseRepositoryPort;
  auditRepo?: AuditRepositoryPort;
  broadcaster?: RealtimeBroadcaster;
  logger: Logger;
}

/**
 * Synchronizes CRM prospect ownership / bot toggles into ISP active cases
 * so the ISP AI bot stays paused when a CRM advisor claims a lead.
 */
export class ReceiveCrmDomainEventUseCase {
  constructor(private readonly deps: ReceiveCrmDomainEventDeps) {}

  async execute(envelope: CrmInboundDomainEventEnvelope): Promise<ReceiveCrmDomainEventResult> {
    const inner = envelope.payload ?? envelope;
    const rawPhone = (inner.phone ?? envelope.phone ?? "").trim();
    const normalizedPhone = normalizePhoneDigits(rawPhone);
    const eventType = (envelope.eventType || "").trim();

    if (!normalizedPhone) {
      return {
        handled: false,
        caseId: null,
        automationEnabled: null,
        reason: "phone_missing",
      };
    }

    const conversation = await this.deps.conversationRepo.findByWaPhone(normalizedPhone);
    if (!conversation) {
      return {
        handled: false,
        caseId: null,
        automationEnabled: null,
        reason: "conversation_not_found",
      };
    }

    let targetCaseId = conversation.activeCaseId;
    if (!targetCaseId) {
      const cases = await this.deps.caseRepo.listByConversation(conversation.id);
      const nonTerminal = cases.find((c) => !TERMINAL_CASE_STATUSES.includes(c.status));
      targetCaseId = nonTerminal?.id ?? null;
    }

    if (!targetCaseId) {
      return {
        handled: false,
        caseId: null,
        automationEnabled: null,
        reason: "active_case_not_found",
      };
    }

    const enableAutomation =
      eventType === "crm.prospect.claimed" || eventType === "crm.prospect.assigned"
        ? false
        : Boolean(inner.automationEnabled ?? envelope.automationEnabled);

    await this.deps.caseRepo.setAutomationEnabled(targetCaseId, enableAutomation, {
      reason: enableAutomation ? null : "CRM_HUMAN_HANDOFF",
    });

    await this.deps.caseRepo.appendEvent(
      targetCaseId,
      enableAutomation ? "AUTOMATION_ENABLED" : "AUTOMATION_DISABLED",
      {
        source: "crm",
        eventType,
        eventId: envelope.eventId ?? null,
        agentName: inner.agentName ?? null,
      },
    );

    this.deps.broadcaster?.publish({
      type: enableAutomation ? "AUTOMATION_ENABLED" : "AUTOMATION_DISABLED",
      caseId: targetCaseId,
      conversationId: conversation.id,
    });

    await this.deps.auditRepo?.record({
      action: enableAutomation ? "CRM_AUTOMATION_ENABLED" : "CRM_AUTOMATION_DISABLED",
      resourceType: "case",
      resourceId: targetCaseId,
      actorId: null,
      metadata: {
        eventType,
        eventId: envelope.eventId ?? null,
        waPhone: normalizedPhone,
        agentName: inner.agentName ?? null,
      },
    });

    this.deps.logger.info(
      { caseId: targetCaseId, eventType, enableAutomation, waPhone: normalizedPhone },
      "evento de dominio CRM sincronizado con automatizacion ISP",
    );

    return {
      handled: true,
      caseId: targetCaseId,
      automationEnabled: enableAutomation,
    };
  }
}
