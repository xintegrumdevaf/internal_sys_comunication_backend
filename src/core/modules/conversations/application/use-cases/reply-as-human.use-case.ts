import { randomUUID } from "node:crypto";
import { notFound, validationError } from "../../../../../shared/errors/domain-errors";
import type { Logger } from "../../../../../shared/logging/logger";
import type { AuditRepositoryPort } from "../../../audit/application/ports/audit.repository.port";
import type { CaseRepositoryPort } from "../../../cases/application/ports/case.repository.port";
import type { CrmBridgePort } from "../../../crm-bridge/application/ports/crm-bridge.port";
import type { AgentRepositoryPort } from "../../../departments/application/ports/agent.repository.port";
import type { DepartmentRepositoryPort } from "../../../departments/application/ports/department.repository.port";
import { assertCanWriteCase, resolveActingAgent } from "../../../escalation/application/use-cases/agent-case-auth";
import { isGeneralDepartment } from "../../../departments/application/services/general-department.helper";
import { emptyContextFor } from "../../../cases/domain/contexts/case-context";
import type { Message } from "../../domain/message.entity";
import type { ConversationRepositoryPort } from "../ports/conversation.repository.port";
import type { MediaStoragePort } from "../ports/media-storage.port";
import type { MessageRepositoryPort } from "../ports/message.repository.port";
import type { WhatsAppMediaType, WhatsAppSenderPort } from "../ports/whatsapp-sender.port";
import {
  extensionFromMimeOrTarget,
  inferContentType,
} from "../../infrastructure/storage/local-media-storage.adapter";

export type ReplyAsHumanMediaInput = {
  buffer: Buffer;
  mimeType?: string;
  filename?: string;
  type?: WhatsAppMediaType | "file";
  mediaUrl?: string;
  voiceNote?: boolean;
};

export type ReplyAsHumanInput = {
  conversationId: string;
  agentUserId?: string | null;
  actorName?: string;
  skipCrmSync?: boolean;
  body?: string;
  caption?: string;
  media?: ReplyAsHumanMediaInput;
  replyToMessageId?: string | null;
  replyToExternalId?: string | null;
};

export type ReplyAsHumanDeps = {
  conversationRepo: ConversationRepositoryPort;
  messageRepo: MessageRepositoryPort;
  whatsappSender: WhatsAppSenderPort;
  auditRepo: AuditRepositoryPort;
  logger: Logger;
  /** Etapa 6: deshabilita automation del caso activo al responder como humano. */
  caseRepo?: CaseRepositoryPort;
  /**
   * docs/spec/06_BACKEND_GAPS.md §2 — si el caso de la conversacion ya esta
   * `HUMAN_ACTIVE`/`ESCALATED`, solo el agente asignado (o manager/admin con
   * alcance) puede responder; el resto queda en solo lectura. Opcionales
   * para no romper construcciones existentes sin este chequeo.
   */
  agentRepo?: AgentRepositoryPort;
  departmentRepo?: DepartmentRepositoryPort;
  /** Almacenamiento local permanente para adjuntos enviados por el agente. */
  mediaStorage?: MediaStoragePort;
  crmBridge?: CrmBridgePort;
};

export function resolveWhatsAppMediaType(
  rawType?: string,
  mimeType?: string | null,
  filename?: string | null,
): WhatsAppMediaType {
  const normalizedType = (rawType || "").toLowerCase().trim();
  if (
    normalizedType === "image" ||
    normalizedType === "video" ||
    normalizedType === "audio" ||
    normalizedType === "document" ||
    normalizedType === "sticker"
  ) {
    return normalizedType;
  }
  if (normalizedType === "file") {
    return "document";
  }

  const mime = (mimeType || "").toLowerCase().trim();
  const fname = (filename || "").toLowerCase().trim();

  if (normalizedType === "sticker" || (mime === "image/webp" && (fname.includes("sticker") || fname.endsWith(".webp")))) {
    return "sticker";
  }
  if (mime.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif)$/i.test(fname)) {
    return "image";
  }
  if (mime.startsWith("video/") || /\.(mp4|mov|webm|3gp|3gpp|mkv|avi)$/i.test(fname)) {
    return "video";
  }
  if (mime.startsWith("audio/") || /\.(ogg|oga|opus|mp3|m4a|wav|aac|amr)$/i.test(fname)) {
    return "audio";
  }
  return "document";
}

/**
 * Respuesta humana (docs/spec/03_API_CONTRACT.md §C.2 `POST /api/conversations/:id/reply`).
 * Soporta tanto texto plano como archivos adjuntos (imágenes, documentos, videos y audios).
 * Fuerza `automation.enabled=false` en el caso activo si no lo estaba.
 */
export class ReplyAsHumanUseCase {
  constructor(private readonly deps: ReplyAsHumanDeps) {}

  async execute(input: ReplyAsHumanInput): Promise<Message> {
    const { conversationRepo, messageRepo, whatsappSender, auditRepo, logger, caseRepo, mediaStorage } = this.deps;

    const textBody = (input.body ?? "").trim();
    const captionText = (input.caption ?? input.body ?? "").trim();

    if (!input.media && !textBody) {
      throw validationError("Debes enviar un mensaje de texto o un archivo adjunto");
    }

    const conversation = await conversationRepo.findById(input.conversationId);
    if (!conversation) {
      throw notFound(`Conversacion ${input.conversationId} no encontrada`);
    }

    if (
      input.agentUserId &&
      caseRepo &&
      typeof caseRepo.listByConversation === "function" &&
      this.deps.agentRepo &&
      this.deps.departmentRepo
    ) {
      const cases = await caseRepo.listByConversation(conversation.id);
      const humanCase = cases.find((c) => c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED");
      if (humanCase) {
        const agent = await resolveActingAgent(this.deps.agentRepo, input.agentUserId);
        await assertCanWriteCase({
          agent,
          caseEntity: humanCase,
          mode: "act",
          agentRepo: this.deps.agentRepo,
          departmentRepo: this.deps.departmentRepo,
        });
      }
    }

    let externalId: string;
    let messageType = "text";
    let mediaId: string | null = null;
    let mimeType: string | null = null;
    let caption: string | null = null;
    let filename: string | null = null;
    let effectiveBody = textBody;

    if (input.media) {
      const resolvedMime =
        inferContentType(input.media.mimeType, input.media.filename || "") ||
        input.media.mimeType ||
        "application/octet-stream";
      const resolvedMediaType = resolveWhatsAppMediaType(
        input.media.type,
        resolvedMime,
        input.media.filename,
      );
      const ext = extensionFromMimeOrTarget(resolvedMime, input.media.filename || "");
      const resolvedFilename =
        input.media.filename?.trim() || `adjunto-${Date.now()}${ext}`;
      const resolvedCaption =
        resolvedMediaType === "audio" || resolvedMediaType === "sticker"
          ? null
          : captionText.length > 0
            ? captionText
            : null;

      const localMediaKey = `outbound-${randomUUID()}${ext}`;
      if (mediaStorage && input.media.buffer.length > 0) {
        await mediaStorage.save(localMediaKey, input.media.buffer, resolvedMime, resolvedFilename);
      }

      try {
        if (!whatsappSender.sendMedia) {
          throw new Error("El adaptador de WhatsApp actual no implementa sendMedia");
        }
        const sendResult = await whatsappSender.sendMedia({
          waPhone: conversation.waPhone,
          type: resolvedMediaType,
          buffer: input.media.buffer,
          mimeType: resolvedMime,
          filename: resolvedFilename,
          caption: resolvedCaption ?? undefined,
          mediaUrl: input.media.mediaUrl,
          voiceNote:
            input.media.voiceNote ??
            (resolvedMediaType === "audio" && (resolvedMime.includes("ogg") || resolvedMime.includes("opus"))),
        });
        externalId = sendResult.externalId;
        mediaId = sendResult.remoteMediaId || localMediaKey;

        if (mediaStorage && sendResult.remoteMediaId && input.media.buffer.length > 0) {
          await mediaStorage.save(
            sendResult.remoteMediaId,
            input.media.buffer,
            resolvedMime,
            resolvedFilename,
          );
        }
      } catch (error) {
        logger.error(
          {
            err: error,
            conversationId: conversation.id,
            agentUserId: input.agentUserId,
            type: resolvedMediaType,
            filename: resolvedFilename,
          },
          "fallo al enviar adjunto de agente por whatsapp",
        );
        throw error;
      }

      messageType = resolvedMediaType;
      mimeType = resolvedMime;
      caption = resolvedCaption;
      filename = resolvedFilename;
      effectiveBody =
        resolvedCaption ||
        (resolvedMediaType === "document" && resolvedFilename
          ? resolvedFilename
          : `[${resolvedMediaType}]`);
    } else {
      try {
        ({ externalId } = await whatsappSender.sendText(conversation.waPhone, textBody));
      } catch (error) {
        logger.error(
          { err: error, conversationId: conversation.id, agentUserId: input.agentUserId },
          "fallo al enviar respuesta de agente por whatsapp",
        );
        throw error;
      }
    }

    let effectiveCaseId = conversation.activeCaseId;
    if (!effectiveCaseId && caseRepo && typeof caseRepo.listByConversation === "function") {
      const cases = await caseRepo.listByConversation(conversation.id);
      const active =
        cases.find((c) => c.status === "HUMAN_ACTIVE" || c.status === "ESCALATED") ??
        cases.find((c) => c.status === "ACTIVE" || c.status === "WAITING_USER") ??
        cases.find((c) => c.status === "NEW");
      if (active) {
        effectiveCaseId = active.id;
      } else {
        // Si no hay ningún caso en la conversación (ej: contacto nuevo o iniciado por agente),
        // creamos automáticamente un caso GENERAL_INQUIRY en HUMAN_ACTIVE asignado al agente.
        let departmentId: string | null = null;
        if (input.agentUserId && this.deps.agentRepo) {
          const agent = await this.deps.agentRepo.findById(input.agentUserId);
          if (agent && agent.primaryDepartmentId) {
            departmentId = agent.primaryDepartmentId;
          }
        }

        const newCase = await caseRepo.create({
          conversationId: conversation.id,
          workflowType: "GENERAL_INQUIRY",
          departmentId,
          context: emptyContextFor("GENERAL_INQUIRY"),
          initialState: "HUMAN_DIRECT",
          expiresAt: null,
        });
        effectiveCaseId = newCase.case.id;

        if (input.agentUserId) {
          await caseRepo.setAssignedAgent(effectiveCaseId, input.agentUserId);
        }
        await caseRepo.applyTransition({
          caseId: effectiveCaseId,
          expectedCaseVersion: newCase.case.version,
          expectedWorkflowVersion: newCase.workflowInstance.version,
          status: "HUMAN_ACTIVE",
          context: newCase.case.context,
          currentState: newCase.workflowInstance.currentState,
          expiresAt: null,
        });
        await conversationRepo.setActiveCaseId(conversation.id, effectiveCaseId);
      }
    }

    const message = await messageRepo.insertOutbound({
      conversationId: conversation.id,
      author: "agent",
      body: effectiveBody,
      externalId,
      agentId: input.agentUserId ?? null,
      caseId: effectiveCaseId,
      type: messageType,
      mediaId,
      mimeType,
      caption,
      filename,
      replyToMessageId: input.replyToMessageId ?? null,
      replyToExternalId: input.replyToExternalId ?? null,
    });

    await conversationRepo.touchLastActivity(conversation.id);

    if (caseRepo && effectiveCaseId) {
      const automation = await caseRepo.getAutomationState(effectiveCaseId);
      if (automation?.enabled !== false) {
        const disabledReason = input.agentUserId ? "HUMAN_REPLY" : "CRM_HUMAN_HANDOFF";
        await caseRepo.setAutomationEnabled(effectiveCaseId, false, {
          reason: disabledReason,
          changedBy: input.agentUserId ?? input.actorName ?? "crm-agent",
        });
        await caseRepo.appendEvent(effectiveCaseId, "AUTOMATION_DISABLED", {
          reason: disabledReason,
          ...(input.actorName ? { actorName: input.actorName } : {}),
        });
      }

      // Si el caso está en General/Triage y el asesor que responde pertenece a un departamento
      // especializado (ej: Facturación, Soporte), el caso adopta automáticamente su departamento.
      if (
        this.deps.agentRepo &&
        this.deps.departmentRepo &&
        typeof caseRepo.findById === "function" &&
        typeof caseRepo.applyTransition === "function"
      ) {
        const currentAggregate = await caseRepo.findById(effectiveCaseId);
        if (currentAggregate) {
          const agent = await this.deps.agentRepo.findById(input.agentUserId);
          if (agent?.primaryDepartmentId) {
            const isGeneralOrTriage = await isGeneralDepartment(
              this.deps.departmentRepo,
              currentAggregate.case.departmentId,
            );
            if (
              isGeneralOrTriage &&
              currentAggregate.case.departmentId !== agent.primaryDepartmentId
            ) {
              await caseRepo.applyTransition({
                caseId: currentAggregate.case.id,
                expectedCaseVersion: currentAggregate.case.version,
                expectedWorkflowVersion: currentAggregate.workflowInstance.version,
                status: currentAggregate.case.status,
                context: currentAggregate.case.context,
                currentState: currentAggregate.workflowInstance.currentState,
                departmentId: agent.primaryDepartmentId,
                expiresAt: currentAggregate.case.expiresAt,
              });
            }
          }
        }
      }
    }

    let replyDepartmentId: string | null = null;
    if (caseRepo && typeof caseRepo.findById === "function" && effectiveCaseId) {
      const c = await caseRepo.findById(effectiveCaseId);
      if (c?.case?.departmentId) replyDepartmentId = c.case.departmentId;
    }
    if (!replyDepartmentId && this.deps.agentRepo && typeof this.deps.agentRepo.findById === "function") {
      const ag = await this.deps.agentRepo.findById(input.agentUserId);
      if (ag?.primaryDepartmentId) replyDepartmentId = ag.primaryDepartmentId;
    }

    await auditRepo.record({
      action: "CONVERSATION_REPLY",
      resourceType: "conversation",
      resourceId: conversation.id,
      actorId: input.agentUserId ?? null,
      departmentId: replyDepartmentId,
      metadata: {
        messageId: message.id,
        type: messageType,
        ...(input.actorName ? { actorName: input.actorName } : {}),
        ...(filename ? { filename } : {}),
      },
    });

    logger.info(
      {
        conversationId: conversation.id,
        messageId: message.id,
        agentUserId: input.agentUserId ?? null,
        actorName: input.actorName,
        type: messageType,
      },
      "respuesta de agente enviada por whatsapp",
    );

    if (!input.skipCrmSync && this.deps.crmBridge?.isEnabled() && caseRepo && effectiveCaseId) {
      void (async () => {
        const agg = await caseRepo.findById(effectiveCaseId);
        const auto = await caseRepo.getAutomationState(effectiveCaseId);
        const isSalesOrCrm =
          agg?.case.workflowType === "SALES" ||
          agg?.case.workflowType === "SALES_PACKAGES" ||
          auto?.disabledReason === "CRM_HUMAN_HANDOFF";
        if (!isSalesOrCrm) return;
        await this.deps.crmBridge!.notifySalesEvent({
          eventId: message.externalId || `isp-human-${message.id}`,
          eventType: "sales.message.sent",
          occurredAt: new Date().toISOString(),
          conversationId: conversation.id,
          caseId: effectiveCaseId,
          customerId: conversation.customerId ?? undefined,
          waPhone: conversation.waPhone,
          fullName: conversation.waProfileName ?? undefined,
          lastMessageBody: effectiveBody,
        });
      })().catch((err) => {
        logger.warn({ err, messageId: message.id }, "fallo notificación de reply humano al CRM");
      });
    }

    return message;
  }
}
