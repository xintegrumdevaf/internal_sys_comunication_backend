const WORKFLOW_LABELS: Record<string, string> = {
  SUPPORT_INTERNET: "Soporte Técnico de Internet",
  BILLING_BALANCE: "Facturación y Pagos",
  GENERAL_INQUIRY: "Consultas Generales",
  UNCLASSIFIED: "Sin clasificar",
  SALES: "Ventas y Contratación",
  SALES_PACKAGES: "Planes y Paquetes",
  HOME_RELOCATION: "Traslado de Domicilio",
  CLAIM_TRIAGE: "Mesa de Triaje",
};

const CASE_STATUS_LABELS: Record<string, string> = {
  NEW: "Nuevo ingreso",
  ACTIVE: "Atendido por IA",
  WAITING_USER: "Esperando respuesta del cliente",
  PAUSED: "En pausa / Seguimiento",
  ESCALATED: "En cola (Sin asignar)",
  HUMAN_ACTIVE: "En atención humana",
  COMPLETED: "Resuelto / Cerrado",
  EXPIRED: "Cerrado por inactividad",
  CANCELLED: "Cancelado / Cerrado",
};

const REASON_LABELS: Record<string, string> = {
  EXTERNAL_SERVICE_ERROR: "Falla temporal de sistema externo",
  REQUEST_HUMAN: "Cliente solicitó asesor humano",
  UNCLEAR: "Consulta no comprendida por IA",
  UNSUPPORTED_ACTION: "Gestión requiere asesor humano",
  MAX_ATTEMPTS_EXCEEDED: "Sin validación tras varios intentos",
  PAYMENT_RECEIPT_ESCALATED: "Comprobante de pago recibido",
  DIAGNOSTIC_FAILED: "Diagnóstico técnico no concluyente",
  CLIENT_NO_RESPONSE: "Cliente no respondió en el plazo",
  INACTIVITY_EXPIRED: "Cerrado por inactividad del cliente",
  AI_WAITING_TIMEOUT: "Derivado automático por tiempo de espera",
  AI_STUCK_TIMEOUT: "Derivado automático por bloqueo en flujo",
  RESOLVED: "Resuelto",
  USER_CANCELLED: "Cancelado por el cliente",
};

export function formatWorkflowLabel(val?: string | null): string {
  if (!val) return "Sin clasificar";
  const key = val.trim().toUpperCase();
  if (WORKFLOW_LABELS[key]) return WORKFLOW_LABELS[key];
  return capitalizeWords(val.replace(/[_-]+/g, " "));
}

export function formatCaseStatusLabel(status?: string | null): string {
  if (!status) return "Sin estado";
  const key = status.trim().toUpperCase();
  return CASE_STATUS_LABELS[key] ?? capitalizeWords(status.replace(/[_-]+/g, " "));
}

export function formatReasonLabel(
  reason?: string | null,
  fallbackWorkflow?: string | null,
): string {
  const raw = reason?.trim();
  if (!raw) {
    return fallbackWorkflow ? formatWorkflowLabel(fallbackWorkflow) : "Sin motivo especificado";
  }

  const upper = raw.toUpperCase();
  if (REASON_LABELS[upper]) return REASON_LABELS[upper];
  if (WORKFLOW_LABELS[upper]) return WORKFLOW_LABELS[upper];

  // Si llega como intent dinámico ej. "cartera.retiro" o "cartera.acuerdo_de_pago"
  if (/^[a-z0-9_-]+\.[a-z0-9_.-]+$/i.test(raw) && !raw.includes(" ")) {
    const parts = raw.split(".");
    const topic = parts.slice(1).join(" ").replace(/[_-]+/g, " ");
    return capitalizeFirst(topic);
  }

  // Si llega todo en MAYUSCULAS_CON_GUIONES
  if (/^[A-Z0-9_]+$/.test(raw)) {
    return capitalizeFirst(raw.toLowerCase().replace(/_/g, " "));
  }

  return capitalizeFirst(raw);
}

function capitalizeFirst(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function capitalizeWords(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
    .join(" ");
}
