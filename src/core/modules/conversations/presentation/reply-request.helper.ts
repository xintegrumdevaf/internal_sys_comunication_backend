import type { Request, Response } from "express";
import { z } from "zod";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { WhatsAppMediaType } from "../application/ports/whatsapp-sender.port";
import type { ReplyAsHumanUseCase } from "../application/use-cases/reply-as-human.use-case";
import type { RealtimeBroadcaster } from "../../realtime/application/realtime-broadcaster";
import {
  extractJsonMediaInputs,
  extractUploadedFiles,
  normalizeUploadedFilename,
} from "./media-proxy.helper";

const replyBodySchema = z.object({
  body: z.string().min(1),
});

export interface ExecuteReplyRequestParams {
  req: Request;
  res: Response;
  conversationId: string;
  agentUserId: string | null;
  actorName?: string;
  skipCrmSync?: boolean;
  replyAsHuman: ReplyAsHumanUseCase;
  broadcaster?: RealtimeBroadcaster;
}

export async function executeReplyOrMediaRequest(
  params: ExecuteReplyRequestParams,
): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const { req, conversationId, agentUserId, actorName, skipCrmSync, replyAsHuman, broadcaster } = params;
  const rawBodyObj = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const uploadedFiles = extractUploadedFiles(req);

  const textOrCaption =
    (typeof rawBodyObj.caption === "string" ? rawBodyObj.caption : undefined) ??
    (typeof rawBodyObj.body === "string" ? rawBodyObj.body : undefined) ??
    (typeof rawBodyObj.message === "string" ? rawBodyObj.message : undefined) ??
    (typeof rawBodyObj.text === "string" ? rawBodyObj.text : undefined);

  const explicitType =
    (typeof rawBodyObj.type === "string" ? rawBodyObj.type : undefined) ??
    (typeof rawBodyObj.attachmentType === "string" ? rawBodyObj.attachmentType : undefined) ??
    (typeof rawBodyObj.mediaType === "string" ? rawBodyObj.mediaType : undefined);

  const explicitFilename =
    (typeof rawBodyObj.filename === "string" ? rawBodyObj.filename : undefined) ??
    (typeof rawBodyObj.fileName === "string" ? rawBodyObj.fileName : undefined);

  const explicitMimeType =
    (typeof rawBodyObj.mimeType === "string" ? rawBodyObj.mimeType : undefined) ??
    (typeof rawBodyObj.contentType === "string" ? rawBodyObj.contentType : undefined);

  const voiceNote = rawBodyObj.voiceNote === true || rawBodyObj.voiceNote === "true";
  const replyToMessageId =
    typeof rawBodyObj.replyToMessageId === "string" ? rawBodyObj.replyToMessageId : undefined;
  const replyToExternalId =
    typeof rawBodyObj.replyToExternalId === "string" ? rawBodyObj.replyToExternalId : undefined;

  if (uploadedFiles.length > 0) {
    const sentMessages = [];
    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i]!;
      const filename =
        (uploadedFiles.length === 1 && explicitFilename ? explicitFilename : undefined) ||
        normalizeUploadedFilename(file.originalname) ||
        `adjunto-${Date.now()}`;
      const mimeType = explicitMimeType || file.mimetype || "application/octet-stream";
      const captionForThisFile = i === 0 ? textOrCaption : undefined;

      const message = await replyAsHuman.execute({
        conversationId,
        agentUserId,
        actorName,
        skipCrmSync,
        body: captionForThisFile,
        caption: captionForThisFile,
        replyToMessageId,
        replyToExternalId,
        media: {
          buffer: file.buffer,
          mimeType,
          filename,
          type: explicitType as WhatsAppMediaType | "file" | undefined,
          voiceNote,
        },
      });

      broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: message.conversationId,
        messageId: message.id,
        author: "agent",
      });
      sentMessages.push(message);
    }

    return {
      statusCode: 201,
      payload: {
        data: sentMessages[sentMessages.length - 1],
        ...(sentMessages.length > 1 ? { messages: sentMessages } : {}),
      },
    };
  }

  const jsonMediaItems = extractJsonMediaInputs(rawBodyObj);
  if (jsonMediaItems.length > 0) {
    const sentMessages = [];
    for (const item of jsonMediaItems) {
      const message = await replyAsHuman.execute({
        conversationId,
        agentUserId,
        actorName,
        skipCrmSync,
        body: item.caption,
        caption: item.caption,
        replyToMessageId,
        replyToExternalId,
        media: item.media,
      });
      broadcaster?.publish({
        type: "MESSAGE_SENT",
        conversationId: message.conversationId,
        messageId: message.id,
        author: "agent",
      });
      sentMessages.push(message);
    }

    return {
      statusCode: 201,
      payload: {
        data: sentMessages[sentMessages.length - 1],
        ...(sentMessages.length > 1 ? { messages: sentMessages } : {}),
      },
    };
  }

  const parsed = replyBodySchema.safeParse({
    body: textOrCaption ?? rawBodyObj.body,
  });
  if (!parsed.success) {
    throw validationError(parsed.error.issues.map((issue) => issue.message).join(", "));
  }

  const message = await replyAsHuman.execute({
    conversationId,
    agentUserId,
    actorName,
    skipCrmSync,
    body: parsed.data.body,
    replyToMessageId,
    replyToExternalId,
  });
  broadcaster?.publish({
    type: "MESSAGE_SENT",
    conversationId: message.conversationId,
    messageId: message.id,
    author: "agent",
  });

  return {
    statusCode: 201,
    payload: { data: message },
  };
}
