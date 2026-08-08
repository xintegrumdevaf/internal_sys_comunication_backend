import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verificacion de firma del webhook de Meta (docs/spec/03_API_CONTRACT.md §E):
 * header `X-Hub-Signature-256`, HMAC-SHA256 del body crudo con el App Secret.
 */
export function verifyWhatsAppSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) {
    return false;
  }

  const [algo, receivedDigest] = signatureHeader.split("=");
  if (algo !== "sha256" || !receivedDigest) {
    return false;
  }

  const expectedDigest = createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const received = Buffer.from(receivedDigest, "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  if (received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(received, expected);
}
