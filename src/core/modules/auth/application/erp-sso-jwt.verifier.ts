import { createHmac, timingSafeEqual } from "node:crypto";
import { authorizationError } from "../../../../shared/errors/domain-errors";

export interface ErpSsoTokenClaims {
  sub: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "agent";
  modules: string[];
  isSuperAdmin: boolean;
}

const DEV_FALLBACK_SECRET = "erp-crm-isp-shared-dev-secret-change-in-prod-2026";

export function verifyErpSsoJwt(token: string): ErpSsoTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw authorizationError("Token SSO ERP inválido.");
  }

  const secret =
    (process.env.ERP_JWT_SECRET || process.env.JWT_SECRET || "").trim() || DEV_FALLBACK_SECRET;
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw authorizationError("Token SSO ERP inválido.");
  }
  const expectedSig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  const sigBuf = Buffer.from(signatureB64, "utf8");
  const expBuf = Buffer.from(expectedSig, "utf8");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw authorizationError("Firma de token SSO ERP inválida.");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw authorizationError("Carga útil de token SSO ERP inválida.");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (typeof payload.sub !== "string" || !payload.sub || exp <= nowSec) {
    throw authorizationError("La sesión SSO del ERP expiró o es inválida.");
  }

  const modules = Array.isArray(payload.modules)
    ? payload.modules.filter((m): m is string => typeof m === "string")
    : [];
  const isSuperAdmin = payload.isSuperAdmin === true;
  if (!isSuperAdmin && !modules.includes("isp")) {
    throw authorizationError("Tu rol en el ERP no tiene acceso al módulo ISP.");
  }

  const roleCodes = Array.isArray(payload.roleCodes)
    ? payload.roleCodes.filter((c): c is string => typeof c === "string")
    : [];
  const resolvedRole: "admin" | "manager" | "agent" = isSuperAdmin
    ? "admin"
    : roleCodes.some((c) => c.includes("supervisor") || c.includes("gerente") || c.includes("admin"))
      ? "manager"
      : "agent";

  return {
    sub: payload.sub,
    name: typeof payload.name === "string" ? payload.name : "Usuario ERP",
    email: typeof payload.email === "string" ? payload.email : "",
    role: resolvedRole,
    modules,
    isSuperAdmin,
  };
}
