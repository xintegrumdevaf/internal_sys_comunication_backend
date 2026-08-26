/**
 * Mensajes de negocio al cliente por razón de escalación
 * (docs/spec/05_BUILD_PLAN.md Etapa 6) — nunca el error técnico crudo.
 */
const BY_REASON: Record<string, string> = {
  TIMEOUT: "Estamos verificando los detalles de tu solicitud y te confirmamos por aquí mismo en un momento.",
  EXTERNAL_SERVICE_ERROR:
    "Estamos revisando tu caso en nuestro sistema y te confirmamos por aquí mismo en cuanto quede listo.",
  AI_ERROR: "¡Recibido, gracias! 🙌 Estamos revisando la información y te confirmamos por aquí mismo en breve.",
  UNSUPPORTED: "¡Recibido, gracias! 🙌 Estamos revisando tu solicitud y te confirmamos por este mismo chat en breve.",
  REQUEST_HUMAN: "¡Con gusto! 🙌 Estamos revisando los detalles para ayudarte por aquí mismo. ¡Un momento por favor!",
  TRIAGE: "¡Recibido, gracias! 🙌 Estamos verificando tu información y te confirmamos por aquí mismo en cuanto quede listo. ¡Gracias por tu confianza!",
  TECHNICAL: "¡Recibido, gracias! 🙌 Estamos revisando la información y te confirmamos por aquí mismo en cuanto quede listo.",
};

export function businessReplyForReason(reason: string, departmentSlug?: string | null): string {
  const key = reason.split(":")[0]?.trim().toUpperCase() ?? "TECHNICAL";
  if (BY_REASON[key]) return BY_REASON[key]!;
  if (BY_REASON[reason]) return BY_REASON[reason]!;
  if (departmentSlug === "support") {
    return "¡Recibido, gracias! 🙌 Estamos revisando los detalles de tu servicio técnico y te confirmamos por aquí mismo en breve.";
  }
  return BY_REASON.TECHNICAL!;
}
