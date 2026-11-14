import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_REPLAY_WINDOW_SEC = 300;

/**
 * Normalizes Ecuador phone numbers to E.164 digits (`5939...`) matching CRM `PhoneE164`.
 */
export function normalizePhoneDigits(rawPhone: string): string {
  const digits = (rawPhone || "").replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("09")) {
    return `593${digits.slice(1)}`;
  }
  if (digits.length === 9 && digits.startsWith("9")) {
    return `593${digits}`;
  }
  return digits;
}

function constantTimeEquals(aStr: string, bStr: string): boolean {
  const a = Buffer.from(aStr, "utf8");
  const b = Buffer.from(bStr, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Builds ADR-003 HMAC-SHA256 headers (`sha256=` over `${timestampSec}.${rawBody}`)
 * for inter-module communication between ISP and CRM backends.
 */
export function signCrmWebhookHeaders(params: {
  rawBody: string;
  webhookSecret?: string;
  internalApiKey?: string;
  idempotencyKey?: string;
  timestampSec?: string;
}): Record<string, string> {
  const timestampSec = params.timestampSec ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-crm-timestamp": timestampSec,
  };

  if (params.idempotencyKey) {
    headers["x-idempotency-key"] = params.idempotencyKey;
  }

  const secret = (params.webhookSecret || "").trim();
  if (secret) {
    const signature = createHmac("sha256", secret)
      .update(`${timestampSec}.${params.rawBody}`)
      .digest("hex");
    headers["x-crm-signature"] = `sha256=${signature}`;
  }

  const internalKey = (params.internalApiKey || "").trim();
  if (internalKey) {
    headers["x-api-internal-key"] = internalKey;
  }

  return headers;
}

/**
 * Verifies inbound requests from CRM_sys_backend using either `x-crm-signature`
 * (with anti-replay timestamp drift window) or `x-api-internal-key`.
 */
export function verifyCrmWebhookAuth(params: {
  rawBody: string;
  signatureHeader?: string;
  timestampHeader?: string;
  internalKeyHeader?: string;
  webhookSecret?: string;
  expectedInternalKeys?: string[];
  maxReplayWindowSec?: number;
}): boolean {
  const internalKey = (params.internalKeyHeader || "").trim();
  const allowedKeys = (params.expectedInternalKeys ?? [])
    .map((k) => k.trim())
    .filter(Boolean);

  if (internalKey && allowedKeys.some((candidate) => constantTimeEquals(internalKey, candidate))) {
    return true;
  }

  const secret = (params.webhookSecret || "").trim();
  if (!secret || !params.signatureHeader) {
    return false;
  }

  const windowSec = params.maxReplayWindowSec ?? DEFAULT_MAX_REPLAY_WINDOW_SEC;
  if (params.timestampHeader) {
    const tsSec = Number(params.timestampHeader);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > windowSec) {
      return false;
    }
  }

  const cleanSig = params.signatureHeader.replace(/^sha256=/i, "").trim().toLowerCase();
  const signingPayload = params.timestampHeader
    ? `${params.timestampHeader}.${params.rawBody}`
    : params.rawBody;
  const expectedSig = createHmac("sha256", secret).update(signingPayload).digest("hex");

  return constantTimeEquals(cleanSig, expectedSig);
}
