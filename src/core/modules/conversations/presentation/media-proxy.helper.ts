import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import type { Env } from "../../../../shared/config/env";
import { validationError } from "../../../../shared/errors/domain-errors";
import type { SystemSettingsService } from "../../settings/application/services/system-settings.service";
import type { MediaStoragePort } from "../application/ports/media-storage.port";
import type { WhatsAppMediaType } from "../application/ports/whatsapp-sender.port";
import type { ReplyAsHumanMediaInput } from "../application/use-cases/reply-as-human.use-case";
import {
  inferContentType,
  isZernioMediaUrl,
  unwrapOwnMediaTarget,
} from "../infrastructure/storage/local-media-storage.adapter";

interface CachedMediaItem {
  buffer: Buffer;
  contentType: string | null;
  timestamp: number;
}

const mediaMemoryCache = new Map<string, CachedMediaItem>();
let mediaMemoryCacheBytes = 0;
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_SINGLE_CACHE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function evictCachedMediaKey(key: string): void {
  const existing = mediaMemoryCache.get(key);
  if (!existing) return;
  mediaMemoryCache.delete(key);
  mediaMemoryCacheBytes = Math.max(0, mediaMemoryCacheBytes - existing.buffer.byteLength);
}

function getCachedMedia(key: string): CachedMediaItem | null {
  const cached = mediaMemoryCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    evictCachedMediaKey(key);
    return null;
  }
  return cached;
}

function setCachedMedia(key: string, buffer: Buffer, contentType: string | null): void {
  if (buffer.byteLength > MAX_SINGLE_CACHE_BYTES) {
    return;
  }
  evictCachedMediaKey(key);
  while (
    mediaMemoryCache.size >= MAX_CACHE_ENTRIES ||
    mediaMemoryCacheBytes + buffer.byteLength > MAX_CACHE_BYTES
  ) {
    const oldestKey = mediaMemoryCache.keys().next().value;
    if (!oldestKey) break;
    evictCachedMediaKey(oldestKey);
  }
  mediaMemoryCache.set(key, { buffer, contentType, timestamp: Date.now() });
  mediaMemoryCacheBytes += buffer.byteLength;
}

export function clearMediaMemoryCache(): void {
  mediaMemoryCache.clear();
  mediaMemoryCacheBytes = 0;
}

export function sendMediaResponse(
  req: Request,
  res: Response,
  buffer: Buffer,
  rawContentType: string | null,
  targetUrl: string,
): void {
  const contentType = inferContentType(rawContentType, targetUrl);
  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  const totalLength = buffer.length;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : totalLength - 1;

      if (start >= totalLength || end >= totalLength || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${totalLength}`);
        res.end();
        return;
      }

      const chunk = buffer.subarray(start, end + 1);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${totalLength}`);
      res.setHeader("Content-Length", chunk.length);
      res.send(chunk);
      return;
    }
  }

  res.setHeader("Content-Length", totalLength);
  res.send(buffer);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

export function maybeParseMultipart(req: Request, res: Response, next: NextFunction): void {
  const contentType = req.headers["content-type"] || "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    upload.any()(req, res, (err) => {
      if (err) {
        next(validationError(`Error al procesar archivo adjunto: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      next();
    });
    return;
  }
  next();
}

export function normalizeUploadedFilename(rawName?: string): string | undefined {
  if (!rawName) return undefined;
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;
  try {
    const utf8 = Buffer.from(trimmed, "latin1").toString("utf8");
    if (!utf8.includes("\uFFFD")) {
      return utf8;
    }
  } catch {
    // fallback a original
  }
  return trimmed;
}

export function extractUploadedFiles(req: Request): Express.Multer.File[] {
  const uploadedFiles: Express.Multer.File[] = [];
  if (req.file) {
    uploadedFiles.push(req.file);
  }
  if (Array.isArray(req.files)) {
    uploadedFiles.push(...req.files);
  } else if (req.files && typeof req.files === "object") {
    for (const list of Object.values(req.files)) {
      if (Array.isArray(list)) {
        uploadedFiles.push(...list);
      }
    }
  }
  return uploadedFiles;
}

function parseBase64Payload(raw: string, fallbackMime?: string): { buffer: Buffer; mimeType?: string } {
  const trimmed = raw.trim();
  const dataUrlMatch = trimmed.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([\s\S]+)$/i);
  if (dataUrlMatch) {
    const detectedMime = dataUrlMatch[1]?.trim() || fallbackMime;
    const base64Data = dataUrlMatch[2]?.replace(/\s+/g, "") || "";
    return {
      buffer: Buffer.from(base64Data, "base64"),
      mimeType: detectedMime,
    };
  }
  return {
    buffer: Buffer.from(trimmed.replace(/\s+/g, ""), "base64"),
    mimeType: fallbackMime,
  };
}

export function extractJsonMediaInputs(bodyObj: Record<string, unknown>): Array<{
  media: ReplyAsHumanMediaInput;
  caption?: string;
}> {
  const results: Array<{ media: ReplyAsHumanMediaInput; caption?: string }> = [];

  const parseSingleItem = (item: Record<string, unknown>, fallbackCaption?: string) => {
    const rawData =
      (typeof item.data === "string" ? item.data : undefined) ??
      (typeof item.base64 === "string" ? item.base64 : undefined) ??
      (typeof item.fileBase64 === "string" ? item.fileBase64 : undefined) ??
      (typeof item.dataUrl === "string" ? item.dataUrl : undefined) ??
      (typeof item.mediaData === "string" ? item.mediaData : undefined);

    const mediaUrl =
      (typeof item.mediaUrl === "string" ? item.mediaUrl : undefined) ??
      (typeof item.attachmentUrl === "string" ? item.attachmentUrl : undefined) ??
      (typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : undefined);

    const rawMime =
      (typeof item.mimeType === "string" ? item.mimeType : undefined) ??
      (typeof item.contentType === "string" ? item.contentType : undefined);

    const rawFilename =
      (typeof item.filename === "string" ? item.filename : undefined) ??
      (typeof item.fileName === "string" ? item.fileName : undefined) ??
      (typeof item.name === "string" ? item.name : undefined);

    const rawType =
      (typeof item.type === "string" ? item.type : undefined) ??
      (typeof item.attachmentType === "string" ? item.attachmentType : undefined) ??
      (typeof item.mediaType === "string" ? item.mediaType : undefined);

    const itemCaption =
      (typeof item.caption === "string" ? item.caption : undefined) ?? fallbackCaption;

    const voiceNote = item.voiceNote === true || item.voiceNote === "true";

    if (rawData) {
      const { buffer, mimeType } = parseBase64Payload(rawData, rawMime);
      if (buffer.length > 0) {
        results.push({
          media: {
            buffer,
            mimeType: mimeType || rawMime,
            filename: rawFilename,
            type: rawType as WhatsAppMediaType | "file" | undefined,
            mediaUrl,
            voiceNote,
          },
          caption: itemCaption,
        });
      }
    } else if (mediaUrl) {
      results.push({
        media: {
          buffer: Buffer.alloc(0),
          mimeType: rawMime,
          filename: rawFilename,
          type: rawType as WhatsAppMediaType | "file" | undefined,
          mediaUrl,
          voiceNote,
        },
        caption: itemCaption,
      });
    }
  };

  const topCaption =
    (typeof bodyObj.caption === "string" ? bodyObj.caption : undefined) ??
    (typeof bodyObj.body === "string" ? bodyObj.body : undefined) ??
    (typeof bodyObj.message === "string" ? bodyObj.message : undefined);

  if (Array.isArray(bodyObj.attachments)) {
    bodyObj.attachments.forEach((att, idx) => {
      if (att && typeof att === "object") {
        parseSingleItem(att as Record<string, unknown>, idx === 0 ? topCaption : undefined);
      }
    });
  } else if (bodyObj.attachment && typeof bodyObj.attachment === "object") {
    parseSingleItem(bodyObj.attachment as Record<string, unknown>, topCaption);
  } else if (bodyObj.media && typeof bodyObj.media === "object") {
    parseSingleItem(bodyObj.media as Record<string, unknown>, topCaption);
  } else {
    parseSingleItem(bodyObj, topCaption);
  }

  return results;
}

export interface MediaProxyDeps {
  env: Env;
  settingsService?: SystemSettingsService;
  mediaStorage?: MediaStoragePort;
  ensureAuth?: (req: Request, zernioMedia: boolean) => void;
}

export async function proxyMediaRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  deps: MediaProxyDeps,
): Promise<void> {
  try {
    const paramTarget =
      (req.params as Record<string, unknown>).path ??
      req.params[0] ??
      (req.params as Record<string, unknown>).mediaId;
    let rawTarget =
      (req.query.url as string) ||
      (Array.isArray(paramTarget) ? paramTarget.join("/") : (paramTarget as string));

    if (!rawTarget) {
      res.status(400).json({ error: "Parametro mediaId o url es requerido" });
      return;
    }

    rawTarget = unwrapOwnMediaTarget(rawTarget);
    let decodedTarget = decodeURIComponent(rawTarget);

    if (/^https?:\/+[^\/]/i.test(decodedTarget)) {
      decodedTarget = decodedTarget.replace(/^(https?):\/*/, "$1://");
    }

    let isUrl = /^https?:\/\//i.test(decodedTarget);
    let resolvedUrl = decodedTarget;

    if (decodedTarget.includes("zernio.com")) {
      const idx = decodedTarget.indexOf("zernio.com");
      resolvedUrl = "https://" + decodedTarget.substring(idx);
      isUrl = true;
    } else if (
      decodedTarget.includes("zernio") ||
      decodedTarget.startsWith("/api/v1/") ||
      decodedTarget.startsWith("api/v1/") ||
      decodedTarget.startsWith("/whatsapp/") ||
      decodedTarget.startsWith("whatsapp/")
    ) {
      const baseUrl = (deps.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1").replace(/\/$/, "");
      let cleanPath = decodedTarget;
      if (!cleanPath.startsWith("/")) cleanPath = "/" + cleanPath;
      resolvedUrl = cleanPath.startsWith("/api/v1/")
        ? `${baseUrl.replace(/\/api\/v1$/, "")}${cleanPath}`
        : `${baseUrl}${cleanPath}`;
      isUrl = true;
    }

    if (isUrl) {
      const queryKeys = Object.keys(req.query).filter((k) => k !== "url");
      if (queryKeys.length > 0) {
        try {
          const urlObj = new URL(resolvedUrl);
          for (const k of queryKeys) {
            if (typeof req.query[k] === "string" && !urlObj.searchParams.has(k)) {
              urlObj.searchParams.set(k, req.query[k] as string);
            }
          }
          resolvedUrl = urlObj.toString();
        } catch {
          // ignore query merge error
        }
      }

      let zernioApiKey = deps.env.ZERNIO_API_KEY || "";
      let zernioAccountId = deps.env.ZERNIO_ACCOUNT_ID || "";
      let zernioBaseUrl = deps.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1";
      if (deps.settingsService) {
        try {
          const s = await deps.settingsService.getChannelSettings();
          if (s.zernioApiKey) zernioApiKey = s.zernioApiKey;
          if (s.zernioAccountId) zernioAccountId = s.zernioAccountId.trim();
          if (s.zernioBaseUrl) zernioBaseUrl = s.zernioBaseUrl.trim();
        } catch {
          // fallback to env
        }
      }

      const zernioBase = zernioBaseUrl.replace(/\/$/, "");
      const zernioMedia = isZernioMediaUrl(resolvedUrl, zernioBase);
      deps.ensureAuth?.(req, zernioMedia);

      if (deps.mediaStorage) {
        const persisted = await deps.mediaStorage.get(resolvedUrl);
        if (persisted) {
          sendMediaResponse(req, res, persisted.buffer, persisted.contentType, resolvedUrl);
          return;
        }
      }

      const cached = getCachedMedia(resolvedUrl);
      if (cached) {
        sendMediaResponse(req, res, cached.buffer, cached.contentType, resolvedUrl);
        return;
      }

      const headers: Record<string, string> = {};
      if (zernioApiKey && zernioMedia) {
        headers["Authorization"] = `Bearer ${zernioApiKey}`;
      }
      let fileRes = await fetch(resolvedUrl, { headers });

      if (!fileRes.ok && (fileRes.status === 404 || fileRes.status === 400) && zernioMedia && zernioAccountId) {
        try {
          const retryUrlObj = new URL(resolvedUrl);
          if (retryUrlObj.searchParams.get("accountId") !== zernioAccountId) {
            retryUrlObj.searchParams.set("accountId", zernioAccountId);
            const retryRes = await fetch(retryUrlObj.toString(), { headers });
            if (retryRes.ok) fileRes = retryRes;
          }
        } catch {
          // ignore retry parse error
        }
      }

      if (!fileRes.ok && !zernioMedia && Object.keys(headers).length > 0) {
        fileRes = await fetch(resolvedUrl);
      }

      if (!fileRes.ok) {
        let errMsg = "No se pudo descargar el archivo de la URL";
        try {
          const errJson = (await fileRes.clone().json()) as { error?: string; message?: string };
          errMsg = errJson.error || errJson.message || errMsg;
        } catch {
          // ignore
        }
        res.status(fileRes.status).json({ error: errMsg });
        return;
      }

      const contentType = fileRes.headers.get("content-type");
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      if (deps.mediaStorage) {
        await deps.mediaStorage.save(resolvedUrl, buffer, contentType);
      } else {
        setCachedMedia(resolvedUrl, buffer, contentType);
      }
      sendMediaResponse(req, res, buffer, contentType, resolvedUrl);
      return;
    }

    deps.ensureAuth?.(req, false);
    const mediaTarget = decodedTarget;

    if (deps.mediaStorage) {
      const persistedMeta = await deps.mediaStorage.get(mediaTarget);
      if (persistedMeta) {
        sendMediaResponse(req, res, persistedMeta.buffer, persistedMeta.contentType, mediaTarget);
        return;
      }
    }

    const cachedMeta = getCachedMedia(mediaTarget);
    if (cachedMeta) {
      sendMediaResponse(req, res, cachedMeta.buffer, cachedMeta.contentType, mediaTarget);
      return;
    }

    let whatsappAccessToken = deps.env.WHATSAPP_ACCESS_TOKEN;
    if (deps.settingsService) {
      try {
        const s = await deps.settingsService.getChannelSettings();
        if (s.accessToken) whatsappAccessToken = s.accessToken;
      } catch {
        // fallback to env
      }
    }

    if (!whatsappAccessToken) {
      res.status(503).json({ error: "WHATSAPP_ACCESS_TOKEN no configurado" });
      return;
    }
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaTarget}`, {
      headers: { Authorization: `Bearer ${whatsappAccessToken}` },
    });
    if (!metaRes.ok) {
      res.status(metaRes.status).json({ error: "No se pudo obtener metadata del archivo" });
      return;
    }
    const metaJson = (await metaRes.json()) as { url: string; mime_type?: string };
    const fileRes = await fetch(metaJson.url, {
      headers: { Authorization: `Bearer ${whatsappAccessToken}` },
    });
    if (!fileRes.ok) {
      res.status(fileRes.status).json({ error: "No se pudo descargar el archivo" });
      return;
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    if (deps.mediaStorage) {
      await deps.mediaStorage.save(mediaTarget, buffer, metaJson.mime_type || null);
    } else {
      setCachedMedia(mediaTarget, buffer, metaJson.mime_type || null);
    }
    sendMediaResponse(req, res, buffer, metaJson.mime_type || null, mediaTarget);
  } catch (error) {
    next(error);
  }
}
