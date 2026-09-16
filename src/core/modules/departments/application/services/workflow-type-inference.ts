/**
 * Infiere el workflowType (SUPPORT_INTERNET, BILLING_BALANCE, SALES_PACKAGES, GENERAL_INQUIRY)
 * basándose en el slug del departamento, nombre, etiqueta del caso, descripción o clave de intención.
 */
export function inferWorkflowType(
  deptSlug: string = "",
  deptName: string = "",
  label: string = "",
  description: string = "",
  intentKey: string = "",
  existingWorkflowType?: string,
): string {
  if (
    existingWorkflowType &&
    existingWorkflowType.trim().length > 0 &&
    existingWorkflowType.trim() !== "GENERAL_INQUIRY"
  ) {
    return existingWorkflowType.trim();
  }

  const combined = `${deptSlug} ${deptName} ${label} ${description} ${intentKey}`.toLowerCase();

  if (
    combined.includes("cartera") ||
    combined.includes("factura") ||
    combined.includes("pago") ||
    combined.includes("cobro") ||
    combined.includes("billing") ||
    combined.includes("saldo") ||
    combined.includes("deuda") ||
    intentKey.toLowerCase().startsWith("billing.") ||
    intentKey.toLowerCase().startsWith("cartera.")
  ) {
    return "BILLING_BALANCE";
  }

  if (
    combined.includes("soporte") ||
    combined.includes("tecnico") ||
    combined.includes("técnico") ||
    combined.includes("internet") ||
    combined.includes("wifi") ||
    combined.includes("red") ||
    combined.includes("lento") ||
    combined.includes("support") ||
    intentKey.toLowerCase().startsWith("support.")
  ) {
    return "SUPPORT_INTERNET";
  }

  if (
    combined.includes("venta") ||
    combined.includes("comercial") ||
    combined.includes("plan") ||
    combined.includes("paquete") ||
    combined.includes("sales") ||
    intentKey.toLowerCase().startsWith("sales.")
  ) {
    return "SALES_PACKAGES";
  }

  return existingWorkflowType?.trim() || "GENERAL_INQUIRY";
}
