import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import type { SystemSettingsService } from "../../../settings/application/services/system-settings.service";
import type {
  EnsureStoredMediaOptions,
  MediaStoragePort,
  StoredMedia,
} from "../../application/ports/media-storage.port";

interface DiskMediaMetadata {
  key: string;
  contentType: string | null;
  filename: string | null;
  ext: string;
  size: number;
  createdAt: string;
}

export interface LocalMediaStorageDeps {
  baseDir?: string;
  env: Env;
  logger?: Logger;
  settingsService?: SystemSettingsService;
}

/**
 * Si un enlace apunta a nuestro propio proxy `/api/media`, extrae el target original.
 */
export function unwrapOwnMediaTarget(raw: string): string {
  let current = raw.trim();
  for (let i = 0; i < 4; i++) {
    let decoded = current;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      decoded = current;
    }
    if (/^https?:\/+[^/]/i.test(decoded)) {
      decoded = decoded.replace(/^(https?):\/+/, "$1://");
    }
    if (!/^https?:\/\//i.test(decoded)) return decoded;
    let url: URL;
    try {
      url = new URL(decoded);
    } catch {
      return decoded;
    }
    if (!url.pathname.startsWith("/api/media")) return decoded;
    const nested = url.searchParams.get("url");
    if (nested) {
      current = nested;
      continue;
    }
    const rest = decodeURIComponent(url.pathname.replace(/^\/api\/media\/?/, "") + url.search);
    if (!rest) return decoded;
    current = rest;
  }
  return current;
}

export function isZernioMediaUrl(resolvedUrl: string, baseUrl: string): boolean {
  try {
    const host = new URL(resolvedUrl).hostname.toLowerCase();
    const baseHost = new URL(baseUrl).hostname.toLowerCase();
    return host === baseHost || host === "zernio.com" || host.endsWith(".zernio.com");
  } catch {
    return false;
  }
}

export function isGoogleMapsUrl(target: string): boolean {
  const lower = target.toLowerCase();
  return lower.includes("maps.google.com") || lower.includes("google.com/maps");
}

/**
 * Normaliza un identificador o URL de media (Meta ID, ruta relativa de Zernio o URL completa)
 * y genera una clave canónica estable para almacenamiento en disco.
 */
export function resolveMediaTarget(
  rawTarget: string,
  zernioBaseUrl = "https://zernio.com/api/v1",
): {
  decodedTarget: string;
  resolvedUrl: string;
  isUrl: boolean;
  canonicalKey: string;
} {
  const unwrapped = unwrapOwnMediaTarget(rawTarget);
  let decodedTarget = unwrapped;
  try {
    decodedTarget = decodeURIComponent(unwrapped);
  } catch {
    decodedTarget = unwrapped;
  }

  if (/^https?:\/+[^/]/i.test(decodedTarget)) {
    decodedTarget = decodedTarget.replace(/^(https?):\/*/, "$1://");
  }

  let isUrl = /^https?:\/\//i.test(decodedTarget);
  let resolvedUrl = decodedTarget;
  const baseUrl = (zernioBaseUrl || "https://zernio.com/api/v1").replace(/\/$/, "");

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
    let cleanPath = decodedTarget;
    if (!cleanPath.startsWith("/")) cleanPath = "/" + cleanPath;

    if (cleanPath.startsWith("/api/v1/")) {
      resolvedUrl = `${baseUrl.replace(/\/api\/v1$/, "")}${cleanPath}`;
    } else {
      resolvedUrl = `${baseUrl}${cleanPath}`;
    }
    isUrl = true;
  }

  let canonicalKey = isUrl ? resolvedUrl : decodedTarget;
  if (isUrl) {
    try {
      const u = new URL(resolvedUrl);
      // Ignorar accountId en la llave canónica para que URLs con y sin ?accountId compartan el mismo archivo en disco
      u.searchParams.delete("accountId");
      canonicalKey = u.toString();
    } catch {
      canonicalKey = resolvedUrl;
    }
  }

  return {
    decodedTarget,
    resolvedUrl,
    isUrl,
    canonicalKey,
  };
}

export function inferContentType(
  rawContentType: string | null | undefined,
  targetUrlOrFilename: string,
): string | null {
  let contentType = rawContentType ? rawContentType.split(";")[0]?.trim() || null : null;
  if (!contentType || contentType === "application/octet-stream") {
    const lower = targetUrlOrFilename.toLowerCase();
    if (lower.includes(".ogg") || lower.includes(".oga") || lower.includes("voice")) {
      contentType = "audio/ogg";
    } else if (lower.includes(".mp3")) {
      contentType = "audio/mpeg";
    } else if (lower.includes(".wav")) {
      contentType = "audio/wav";
    } else if (lower.includes(".m4a")) {
      contentType = "audio/mp4";
    } else if (lower.includes(".opus")) {
      contentType = "audio/opus";
    } else if (lower.includes(".mp4")) {
      contentType = "video/mp4";
    } else if (lower.includes(".webm")) {
      contentType = lower.includes("audio") ? "audio/webm" : "video/webm";
    } else if (lower.includes(".3gp") || lower.includes(".3gpp")) {
      contentType = "video/3gpp";
    } else if (lower.includes(".mov")) {
      contentType = "video/quicktime";
    } else if (lower.includes("audio")) {
      contentType = "audio/ogg";
    } else if (lower.includes("video")) {
      contentType = "video/mp4";
    } else if (lower.includes(".jpg") || lower.includes(".jpeg")) {
      contentType = "image/jpeg";
    } else if (lower.includes(".png")) {
      contentType = "image/png";
    } else if (lower.includes(".webp")) {
      contentType = "image/webp";
    } else if (lower.includes(".gif")) {
      contentType = "image/gif";
    } else if (lower.includes(".pdf")) {
      contentType = "application/pdf";
    }
  }
  return contentType;
}

export function extensionFromMimeOrTarget(
  contentType: string | null,
  targetUrlOrFilename: string,
): string {
  const mime = (contentType || "").toLowerCase().split(";")[0]?.trim() || "";
  const mimeToExt: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/amr": ".amr",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/3gpp": ".3gp",
    "video/quicktime": ".mov",
    "application/pdf": ".pdf",
  };

  if (mime && mimeToExt[mime]) {
    return mimeToExt[mime]!;
  }

  try {
    const cleanPath = targetUrlOrFilename.split("?")[0] ?? "";
    const ext = path.extname(cleanPath).toLowerCase();
    if (ext && /^\.[a-z0-9]{2,5}$/.test(ext)) {
      return ext;
    }
  } catch {
    // ignore
  }

  return ".bin";
}

/**
 * Adaptador de almacenamiento permanente en disco local para imágenes, audios, videos y documentos.
 * Retención indefinida: los archivos persistidos en `public/uploads/media` nunca caducan.
 */
export class LocalMediaStorageAdapter implements MediaStoragePort {
  private readonly baseDir: string;
  private readonly memoryCache = new Map<string, StoredMedia>();
  private readonly inFlightDownloads = new Map<string, Promise<StoredMedia | null>>();
  private readonly maxMemoryEntries = 200;

  constructor(private readonly deps: LocalMediaStorageDeps) {
    this.baseDir =
      deps.baseDir ||
      deps.env.MEDIA_STORAGE_DIR ||
      path.join(process.cwd(), "public", "uploads", "media");
  }

  public clearMemoryCache(): void {
    this.memoryCache.clear();
  }

  private setMemoryCache(key: string, item: StoredMedia): void {
    if (this.memoryCache.size >= this.maxMemoryEntries && !this.memoryCache.has(key)) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
      }
    }
    this.memoryCache.set(key, item);
  }

  private hashKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
  }

  private getPathsForHash(hash: string, ext = ".bin"): {
    shardDir: string;
    metaPath: string;
    dataPath: string;
  } {
    const shard = hash.slice(0, 2);
    const shardDir = path.join(this.baseDir, shard);
    return {
      shardDir,
      metaPath: path.join(shardDir, `${hash}.meta.json`),
      dataPath: path.join(shardDir, `${hash}${ext}`),
    };
  }

  private async readFromDiskByKey(key: string): Promise<StoredMedia | null> {
    const hash = this.hashKey(key);
    const { shardDir, metaPath } = this.getPathsForHash(hash);

    try {
      const rawMeta = await fs.readFile(metaPath, "utf-8");
      const meta = JSON.parse(rawMeta) as DiskMediaMetadata;
      const ext = meta.ext || ".bin";
      const filePath = path.join(shardDir, `${hash}${ext}`);
      const buffer = await fs.readFile(filePath);
      return {
        buffer,
        contentType: meta.contentType,
        filename: meta.filename,
        filePath,
      };
    } catch {
      return null;
    }
  }

  async get(mediaTarget: string): Promise<StoredMedia | null> {
    if (!mediaTarget || !mediaTarget.trim()) return null;

    const zernioBaseUrl = this.deps.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1";
    const { decodedTarget, resolvedUrl, canonicalKey } = resolveMediaTarget(
      mediaTarget,
      zernioBaseUrl,
    );

    const candidateKeys = Array.from(new Set([canonicalKey, resolvedUrl, decodedTarget, mediaTarget]));

    for (const key of candidateKeys) {
      const inMem = this.memoryCache.get(key);
      if (inMem) {
        return inMem;
      }
    }

    for (const key of candidateKeys) {
      const fromDisk = await this.readFromDiskByKey(key);
      if (fromDisk) {
        this.setMemoryCache(canonicalKey, fromDisk);
        if (resolvedUrl !== canonicalKey) {
          this.setMemoryCache(resolvedUrl, fromDisk);
        }
        return fromDisk;
      }
    }

    return null;
  }

  async save(
    mediaTarget: string,
    buffer: Buffer,
    contentType?: string | null,
    filename?: string | null,
  ): Promise<StoredMedia> {
    const zernioBaseUrl = this.deps.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1";
    const { resolvedUrl, canonicalKey } = resolveMediaTarget(mediaTarget, zernioBaseUrl);

    const effectiveContentType = inferContentType(
      contentType,
      filename || resolvedUrl || mediaTarget,
    );
    const ext = extensionFromMimeOrTarget(
      effectiveContentType,
      filename || resolvedUrl || mediaTarget,
    );

    const hash = this.hashKey(canonicalKey);
    const { shardDir, metaPath, dataPath } = this.getPathsForHash(hash, ext);

    await fs.mkdir(shardDir, { recursive: true });
    await fs.writeFile(dataPath, buffer);

    const metadata: DiskMediaMetadata = {
      key: canonicalKey,
      contentType: effectiveContentType,
      filename: filename ?? null,
      ext,
      size: buffer.length,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), "utf-8");

    const stored: StoredMedia = {
      buffer,
      contentType: effectiveContentType,
      filename: filename ?? null,
      filePath: dataPath,
    };

    this.setMemoryCache(canonicalKey, stored);
    if (resolvedUrl !== canonicalKey) {
      this.setMemoryCache(resolvedUrl, stored);
    }

    return stored;
  }

  async ensureStored(
    mediaTarget: string,
    options?: EnsureStoredMediaOptions,
  ): Promise<StoredMedia | null> {
    if (!mediaTarget || !mediaTarget.trim() || isGoogleMapsUrl(mediaTarget)) {
      return null;
    }

    const existing = await this.get(mediaTarget);
    if (existing) {
      return existing;
    }

    const zernioBaseUrl = this.deps.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1";
    const { canonicalKey } = resolveMediaTarget(mediaTarget, zernioBaseUrl);

    const inFlight = this.inFlightDownloads.get(canonicalKey);
    if (inFlight) {
      return inFlight;
    }

    const downloadPromise = this.downloadAndPersist(mediaTarget, options).finally(() => {
      this.inFlightDownloads.delete(canonicalKey);
    });

    this.inFlightDownloads.set(canonicalKey, downloadPromise);
    return downloadPromise;
  }

  private async downloadAndPersist(
    mediaTarget: string,
    options?: EnsureStoredMediaOptions,
  ): Promise<StoredMedia | null> {
    let zernioApiKey = this.deps.env.ZERNIO_API_KEY || "";
    let zernioAccountId = this.deps.env.ZERNIO_ACCOUNT_ID || "";
    let zernioBaseUrl = this.deps.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1";
    let whatsappAccessToken = this.deps.env.WHATSAPP_ACCESS_TOKEN || "";

    if (this.deps.settingsService) {
      try {
        const s = await this.deps.settingsService.getChannelSettings();
        if (s.zernioApiKey) zernioApiKey = s.zernioApiKey;
        if (s.zernioAccountId) zernioAccountId = s.zernioAccountId.trim();
        if (s.zernioBaseUrl) zernioBaseUrl = s.zernioBaseUrl.trim();
        if (s.accessToken) whatsappAccessToken = s.accessToken;
      } catch {
        // fallback a env
      }
    }

    const { decodedTarget, resolvedUrl, isUrl } = resolveMediaTarget(mediaTarget, zernioBaseUrl);

    if (isUrl) {
      const zernioBase = zernioBaseUrl.replace(/\/$/, "");
      const zernioMedia = isZernioMediaUrl(resolvedUrl, zernioBase);

      const headers: Record<string, string> = {};
      if (zernioApiKey && zernioMedia) {
        headers["Authorization"] = `Bearer ${zernioApiKey}`;
      }

      let fileRes = await fetch(resolvedUrl, { headers });

      if (
        !fileRes.ok &&
        (fileRes.status === 404 || fileRes.status === 400) &&
        zernioMedia &&
        zernioAccountId
      ) {
        try {
          const retryUrlObj = new URL(resolvedUrl);
          if (retryUrlObj.searchParams.get("accountId") !== zernioAccountId) {
            retryUrlObj.searchParams.set("accountId", zernioAccountId);
            const retryRes = await fetch(retryUrlObj.toString(), { headers });
            if (retryRes.ok) {
              fileRes = retryRes;
            }
          }
        } catch {
          // Ignorar error de parsing en reintento
        }
      }

      if (!fileRes.ok && !zernioMedia && Object.keys(headers).length > 0) {
        fileRes = await fetch(resolvedUrl);
      }

      if (!fileRes.ok) {
        this.deps.logger?.warn(
          { status: fileRes.status, resolvedUrl },
          "No se pudo descargar archivo multimedia desde URL remota para almacenamiento local",
        );
        return null;
      }

      const contentType = fileRes.headers.get("content-type") || options?.mimeType || null;
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const saved = await this.save(resolvedUrl, buffer, contentType, options?.filename);
      this.deps.logger?.info(
        { resolvedUrl, size: buffer.length, contentType: saved.contentType },
        "Archivo multimedia descargado y persistido permanentemente en disco local",
      );
      return saved;
    }

    // Meta Graph API media ID
    if (!whatsappAccessToken) {
      this.deps.logger?.warn(
        { mediaId: decodedTarget },
        "WHATSAPP_ACCESS_TOKEN no configurado; no se puede descargar media de Meta",
      );
      return null;
    }

    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${decodedTarget}`, {
      headers: { Authorization: `Bearer ${whatsappAccessToken}` },
    });
    if (!metaRes.ok) {
      this.deps.logger?.warn(
        { status: metaRes.status, mediaId: decodedTarget },
        "No se pudo obtener metadata de archivo multimedia desde Meta Graph API",
      );
      return null;
    }

    const metaJson = (await metaRes.json()) as { url: string; mime_type?: string };
    const fileRes = await fetch(metaJson.url, {
      headers: { Authorization: `Bearer ${whatsappAccessToken}` },
    });
    if (!fileRes.ok) {
      this.deps.logger?.warn(
        { status: fileRes.status, mediaId: decodedTarget },
        "No se pudo descargar binario multimedia desde Meta Graph API",
      );
      return null;
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const contentType = metaJson.mime_type || options?.mimeType || null;
    const saved = await this.save(decodedTarget, buffer, contentType, options?.filename);
    this.deps.logger?.info(
      { mediaId: decodedTarget, size: buffer.length, contentType: saved.contentType },
      "Archivo multimedia de Meta descargado y persistido permanentemente en disco local",
    );
    return saved;
  }
}

