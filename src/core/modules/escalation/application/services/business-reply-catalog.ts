/**
 * Mensajes de negocio al cliente por razón de escalación
 * (docs/spec/05_BUILD_PLAN.md Etapa 6) — nunca el error técnico crudo.
 */
const BY_REASON: Record<string, string> = {
  TIMEOUT: "Estamos teniendo una demora técnica. Un especialista revisará tu caso en breve.",
  EXTERNAL_SERVICE_ERROR:
    "Hay un problema temporal con nuestros sistemas. Un especialista se pondrá en contacto contigo.",
  AI_ERROR: "Un especialista revisará tu solicitud para ayudarte mejor.",
  UNSUPPORTED: "Un especialista revisará tu solicitud y te contactará por este chat.",
  REQUEST_HUMAN: "Te conectamos con un especialista humano. En breve te atenderán por este mismo chat.",
  TRIAGE: "Un especialista revisará tu solicitud. Te responderemos por este mismo chat.",
  TECHNICAL: "No pudimos completar el proceso automático. Un especialista te atenderá en breve.",
};

export function businessReplyForReason(reason: string, departmentSlug?: string | null): string {
  const key = reason.split(":")[0]?.trim().toUpperCase() ?? "TECHNICAL";
  if (BY_REASON[key]) return BY_REASON[key]!;
  if (BY_REASON[reason]) return BY_REASON[reason]!;
  if (departmentSlug === "support") {
    return "Un especialista de soporte técnico revisará tu caso y te contactará pronto.";
  }
  return BY_REASON.TECHNICAL!;
}
