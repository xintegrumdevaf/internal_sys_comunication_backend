import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verificacion de firma del webhook de Zernio:
 * Header `X-Zernio-Signature` (o legacy `X-Late-Signature`),
 * HMAC-SHA256 del body crudo con el secret configurado en Zernio.
 */
export function verifyZernioSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  webhookSecret: string | undefined,
): boolean {
  // Si no hay secreto configurado en el servidor (desarrollo local), permitimos pasar
  if (!webhookSecret) {
    return true;
  }

  if (!signatureHeader) {
    return false;
  }

  const expectedDigest = createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  const received = Buffer.from(signatureHeader.trim().toLowerCase(), "hex");
  const expected = Buffer.from(expectedDigest.toLowerCase(), "hex");

  if (received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(received, expected);
}
