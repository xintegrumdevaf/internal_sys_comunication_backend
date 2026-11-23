/**
 * Diccionario y normalizador de errores de entrega de WhatsApp Cloud API / Meta / Zernio.
 * Traduce códigos técnicos y mensajes en inglés a explicaciones claras en español para los operadores.
 */

export function is24HourWindowError(
  rawError?: string | null,
  code?: number | string | null,
): boolean {
  if (code !== undefined && code !== null) {
    const codeStr = String(code).trim();
    if (codeStr === "131047") return true;
  }

  if (!rawError) return false;
  const lower = rawError.toLowerCase();

  return (
    lower.includes("131047") ||
    lower.includes("24 hours") ||
    lower.includes("24-hour") ||
    lower.includes("customer service window") ||
    lower.includes("re-engagement") ||
    (lower.includes("template") &&
      lower.includes("required") &&
      (lower.includes("24") || lower.includes("window") || lower.includes("expire") || lower.includes("reopen") || lower.includes("re-engage")))
  );
}

export function translateDeliveryError(
  rawError?: string | null,
  code?: number | string | null,
): string {
  const codeStr = code !== undefined && code !== null ? String(code).trim() : null;
  const raw = (rawError || "").trim();
  const lower = raw.toLowerCase();

  // 1. Error 131049: Límite de marketing / ecosistema de Meta
  if (
    codeStr === "131049" ||
    lower.includes("131049") ||
    lower.includes("healthy ecosystem engagement") ||
    lower.includes("ecosystem engagement") ||
    lower.includes("marketing message limit")
  ) {
    return "Límite de protección de Meta: Meta bloqueó la entrega para evitar saturar al destinatario con mensajes de marketing/campaña (Error Meta 131049).";
  }

  // 2. Error 131047: Ventana de 24 horas cerrada
  if (is24HourWindowError(raw, codeStr)) {
    return "Ventana de 24 horas cerrada: Han transcurrido más de 24h desde el último mensaje del cliente. WhatsApp requiere una plantilla oficial (Template) aprobada para reabrir la conversación (Error Meta 131047).";
  }

  // 2.b. Plantilla obligatoria al iniciar nueva conversación (o chat no indexado en Zernio)
  if (
    lower.includes("template_required") ||
    lower.includes("must start with an approved template") ||
    (lower.includes("template") && lower.includes("required"))
  ) {
    return "Plantilla requerida: WhatsApp exige una plantilla oficial (Template) aprobada para iniciar una conversación nueva con este número, o no se indexó la conversación activa en Zernio (TEMPLATE_REQUIRED).";
  }

  // 3. Error 131026: Número no disponible o sin WhatsApp
  if (
    codeStr === "131026" ||
    lower.includes("131026") ||
    lower.includes("message undeliverable") ||
    lower.includes("undeliverable")
  ) {
    return "Número no disponible: El destinatario no tiene una cuenta activa de WhatsApp o no puede recibir mensajes en este momento (Error Meta 131026).";
  }

  // 4. Error 131051: Límite de tipo de mensaje superado
  if (codeStr === "131051" || lower.includes("131051") || lower.includes("unsupported message type")) {
    return "Tipo de mensaje no admitido o se superó el límite de frecuencia para este tipo de contenido (Error Meta 131051).";
  }

  // 5. Error 131056: Discrepancia de parámetros de plantilla
  if (
    codeStr === "131056" ||
    lower.includes("131056") ||
    lower.includes("param count mismatch") ||
    lower.includes("variable mapping")
  ) {
    return "Error en plantilla: Las variables enviadas no coinciden con la cantidad de parámetros de la plantilla aprobada (Error Meta 131056).";
  }

  // 6. Error 132000: Plantilla no existe
  if (
    codeStr === "132000" ||
    lower.includes("132000") ||
    lower.includes("template does not exist")
  ) {
    return "La plantilla indicada no existe o no está aprobada en el idioma seleccionado (Error Meta 132000).";
  }

  // 7. Error 132001: Plantilla pausada por Meta
  if (codeStr === "132001" || lower.includes("132001") || lower.includes("template paused")) {
    return "Plantilla pausada temporalmente por Meta debido a reportes de baja calidad de los usuarios (Error Meta 132001).";
  }

  // 8. Error 132007: Plantilla deshabilitada
  if (codeStr === "132007" || lower.includes("132007") || lower.includes("template disabled")) {
    return "Plantilla deshabilitada permanentemente por Meta por infracción de políticas de mensajería (Error Meta 132007).";
  }

  // 9. Error 130429 o 429: Rate limit de Meta o Zernio
  if (
    codeStr === "130429" ||
    codeStr === "429" ||
    lower.includes("130429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return "Límite de tasa alcanzado: Se superó la cantidad de mensajes permitidos por segundo en Meta/Zernio (Error Rate Limit).";
  }

  // 10. Error 131052 / 131053: Error en multimedia
  if (codeStr === "131052" || lower.includes("131052")) {
    return "Error al descargar el archivo multimedia en el dispositivo del destinatario (Error Meta 131052).";
  }
  if (codeStr === "131053" || lower.includes("131053")) {
    return "Error al cargar el archivo multimedia en los servidores de WhatsApp/Meta (Error Meta 131053).";
  }

  // 11. Error 190: Token de acceso expirado
  if (codeStr === "190" || lower.includes("190") || lower.includes("oauthexception") || lower.includes("token")) {
    return "Token de acceso de Meta expirado o revocado. Es necesario reconectar las credenciales de WhatsApp (Error Meta 190).";
  }

  // 12. Error 100: Parámetros inválidos
  if (codeStr === "100" || lower.includes("100") || lower.includes("invalid parameter")) {
    return "Parámetro inválido en la llamada a la API de WhatsApp/Meta (Error Meta 100).";
  }

  // 13. Fallos de red / conexión
  if (lower.includes("etimedout") || lower.includes("timed out") || lower.includes("timeout")) {
    return "Tiempo de espera agotado: El servidor de mensajería no respondió a tiempo (Timeout / ETIMEDOUT).";
  }
  if (lower.includes("econnreset") || lower.includes("econnrefused")) {
    return "Fallo de conexión de red con el servidor de mensajería (Conexión interrumpida).";
  }

  // Si ya viene con texto descriptivo en español, conservarlo
  if (raw && !lower.includes("meta error") && !lower.includes("failed to be delivered")) {
    return raw;
  }

  // Fallback con código si está disponible
  const suffix = codeStr ? ` (Error Meta ${codeStr})` : "";
  return raw ? `${raw}${suffix}` : `Error de entrega en WhatsApp / Meta${suffix}`;
}

