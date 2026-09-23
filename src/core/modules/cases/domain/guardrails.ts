/**
 * Guardrails de seguridad conversacional y contención de clientes hostiles.
 * Detecta expresiones soeces, hostilidad explícita y negativas rotundas
 * para frenar bucles automáticos y forzar la atención humana inmediata.
 */

// Palabras y expresiones soeces comunes en Ecuador y Latinoamérica
const PROFANITY_PATTERNS: RegExp[] = [
  /\bchucha\b/i,
  /\bverga\b/i,
  /\ba la verga\b/i,
  /\bcomo verga\b/i,
  /\bque verga\b/i,
  /\bhuevada[s]?\b/i,
  /\bhuevon[es]?\b/i,
  /\bmierda\b/i,
  /\bhdp\b/i,
  /\bhijo[s]? de puta\b/i,
  /\bmalparido[s]?\b/i,
  /\bputa[s]?\b/i,
  /\bputo[s]?\b/i,
  /\bcarajo\b/i,
  /\bpendejo[s]?\b/i,
  /\bestupido[s]?\b/i,
  /\bidiota[s]?\b/i,
  /\bno jodan\b/i,
  /\bno joda\b/i,
  /\bdejen de joder\b/i,
  /\bque joden\b/i,
];

// Expresiones explícitas de rechazo o negativa a proporcionar datos requeridos
const REFUSAL_PATTERNS: RegExp[] = [
  /\bno voy a dar\b/i,
  /\bno les voy a dar\b/i,
  /\bno te voy a dar\b/i,
  /\bno les debo\b/i,
  /\bno debo nada\b/i,
  /\bbusquen\b/i,
  /\bbusquen ustedes\b/i,
  /\bbusquen pues\b/i,
  /\bvusqen\b/i,
  /\bvusqen pues\b/i,
  /\bahi tienen\b/i,
  /\bvengan y lleven\b/i,
  /\bvengan a llevar\b/i,
  /\bno me da la gana\b/i,
  /\bno quiero dar\b/i,
  /\bno quiero decir\b/i,
];

export type GuardrailCheckResult = {
  isHostile: boolean;
  isRefusal: boolean;
  shouldEscalate: boolean;
  reason?: string;
};

/**
 * Evalúa si el texto ingresado por el cliente presenta hostilidad,
 * groserías o rechazo explícito a colaborar con el asistente.
 */
export function checkCustomerGuardrails(text?: string): GuardrailCheckResult {
  if (!text || typeof text !== "string") {
    return { isHostile: false, isRefusal: false, shouldEscalate: false };
  }

  const clean = text.trim();
  if (!clean) {
    return { isHostile: false, isRefusal: false, shouldEscalate: false };
  }

  const matchesProfanity = PROFANITY_PATTERNS.some((pattern) => pattern.test(clean));
  if (matchesProfanity) {
    return {
      isHostile: true,
      isRefusal: false,
      shouldEscalate: true,
      reason: "Lenguaje hostil o inapropiado detectado en mensaje del cliente",
    };
  }

  const matchesRefusal = REFUSAL_PATTERNS.some((pattern) => pattern.test(clean));
  if (matchesRefusal) {
    return {
      isHostile: false,
      isRefusal: true,
      shouldEscalate: true,
      reason: "Cliente rechazó explícitamente proporcionar los datos requeridos",
    };
  }

  return { isHostile: false, isRefusal: false, shouldEscalate: false };
}
