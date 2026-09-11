import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Env } from "../../../../../shared/config/env";
import type { Logger } from "../../../../../shared/logging/logger";
import { validationError } from "../../../../../shared/errors/domain-errors";

const GRAPH_API_VERSION = "v20.0";

export async function uploadMediaHeaderHandle(
  headerContent: string,
  env: Env,
  logger: Logger,
): Promise<string> {
  const trimmed = headerContent.trim();
  if (!trimmed) {
    throw validationError("El contenido de encabezado multimedia está vacío.");
  }

  // Si ya es un handle válido de Meta (ej. "2:c2F...", "4:...", "upload:...") y no es URL/data
  if (
    !trimmed.startsWith("http://") &&
    !trimmed.startsWith("https://") &&
    !trimmed.startsWith("data:") &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\") &&
    (trimmed.includes(":") || /^[0-9]+$/.test(trimmed))
  ) {
    return trimmed;
  }

  const accessToken = env.META_ACCESS_TOKEN?.trim() || env.WHATSAPP_ACCESS_TOKEN?.trim();
  const wabaId = env.META_WABA_ID?.trim();

  if (!accessToken || !wabaId) {
    throw validationError(
      "Para enviar plantillas con encabezado multimedia (Imagen, Video o Documento), debes tener configurados WHATSAPP_ACCESS_TOKEN y META_WABA_ID en las variables de entorno (.env).",
    );
  }

  let buffer: Buffer;
  let mimeType = "image/jpeg";
  let fileName = "sample_header.jpg";

  if (trimmed.startsWith("data:")) {
    const matches = trimmed.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches || !matches[2]) {
      throw validationError("El formato de datos base64 del archivo multimedia no es válido.");
    }
    mimeType = matches[1] || "image/jpeg";
    buffer = Buffer.from(matches[2], "base64");
  } else if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const res = await fetch(trimmed);
      if (!res.ok) {
        throw validationError(`No se pudo descargar la imagen/archivo de muestra desde la URL (${res.status})`);
      }
      const headerMime = res.headers.get("content-type");
      if (headerMime) mimeType = headerMime.split(";")[0]?.trim() || mimeType;
      const arrayBuf = await res.arrayBuffer();
      buffer = Buffer.from(arrayBuf);
    } catch (err) {
      if (err && typeof err === "object" && (err as { name?: string }).name === "AppError") throw err;
      throw validationError(
        `Fallo de red al descargar el recurso multimedia de muestra: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    throw validationError(
      "El archivo de muestra del encabezado debe enviarse en formato URL (http/https) o base64 (data:image/...;base64,...).",
    );
  }

  if (mimeType.includes("png")) fileName = "sample_header.png";
  else if (mimeType.includes("pdf")) fileName = "sample_header.pdf";
  else if (mimeType.includes("mp4")) fileName = "sample_header.mp4";
  else if (mimeType.includes("webp")) fileName = "sample_header.webp";

  const sessionUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/uploads?file_name=${encodeURIComponent(
    fileName,
  )}&file_length=${buffer.length}&file_type=${encodeURIComponent(mimeType)}`;

  try {
    let sessionRes = await fetch(sessionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!sessionRes.ok) {
      const fallbackUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/app/uploads?file_name=${encodeURIComponent(
        fileName,
      )}&file_length=${buffer.length}&file_type=${encodeURIComponent(mimeType)}`;
      sessionRes = await fetch(fallbackUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
    }

    if (!sessionRes.ok) {
      const errBody = await sessionRes.text();
      logger.error({ status: sessionRes.status, body: errBody }, "Error al iniciar sesión de carga de archivo en Meta");
      throw validationError(`Meta API rechazó la carga del archivo de muestra (${sessionRes.status}): ${errBody}`);
    }

    const sessionData = (await sessionRes.json()) as { id?: string };
    const uploadSessionId = sessionData.id;

    if (!uploadSessionId) {
      throw validationError("Meta API no devolvió un ID de sesión de carga de archivo válido.");
    }

    const uploadUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${uploadSessionId}`;
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${accessToken}`,
        file_offset: "0",
        "Content-Type": "application/octet-stream",
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const errBody = await uploadRes.text();
      logger.error({ status: uploadRes.status, body: errBody }, "Error al subir binarios a Meta Upload Session");
      throw validationError(`Error al subir el archivo multimedia a Meta (${uploadRes.status}): ${errBody}`);
    }

    const uploadData = (await uploadRes.json()) as { h?: string };
    if (!uploadData.h) {
      throw validationError("Meta API no devolvió un handle (h) válido para el archivo multimedia.");
    }

    logger.info({ handle: uploadData.h }, "Handle de multimedia de muestra generado exitosamente en Meta");
    return uploadData.h;
  } catch (error) {
    if (error && typeof error === "object" && (error as { name?: string }).name === "AppError") throw error;
    logger.error({ err: error }, "Fallo al procesar handle multimedia en Meta");
    throw validationError(
      `No se pudo preparar la muestra multimedia para Meta: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function resolveHeaderMediaUrl(
  headerContent: string,
  env: Env,
  logger: Logger,
): Promise<string> {
  const trimmed = headerContent.trim();
  if (!trimmed) {
    throw validationError("El contenido del encabezado multimedia no puede estar vacío.");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  if (trimmed.startsWith("data:")) {
    const matches = trimmed.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches || !matches[2]) {
      throw validationError("El formato de datos base64 del archivo multimedia no es válido.");
    }
    const mimeType = matches[1] || "image/jpeg";
    const buffer = Buffer.from(matches[2], "base64");

    let ext = "jpg";
    if (mimeType.includes("png")) ext = "png";
    else if (mimeType.includes("pdf")) ext = "pdf";
    else if (mimeType.includes("mp4")) ext = "mp4";
    else if (mimeType.includes("webp")) ext = "webp";

    const fileName = `sample_${randomUUID()}.${ext}`;
    const uploadDir = path.join(process.cwd(), "public", "uploads", "template-samples");

    fs.mkdirSync(uploadDir, { recursive: true });
    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, buffer);

    const baseUrl = (env.APP_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
    const publicUrl = `${baseUrl}/uploads/template-samples/${fileName}`;
    logger.info({ publicUrl }, "Muestra multimedia guardada localmente y publicada para Zernio");
    return publicUrl;
  }

  throw validationError(
    "El archivo de muestra del encabezado debe enviarse en formato URL pública (http/https) o ser un archivo cargado en la vista previa.",
  );
}
