import { intentListForPrompt } from "../../../cases/domain/intent-catalog";
import type { InterpretMessageInput } from "../ports/ai-provider.port";

/**
 * Prompt normativo de interpretMessage (docs/spec/06_AI_PROMPTS.md §3).
 * requireAll/requireAny se inyectan por llamada desde el WaitingStep activo.
 */
export function buildInterpretMessagePrompt(input: InterpretMessageInput): {
  system: string;
  user: string;
} {
  const intents = intentListForPrompt();
  const active = input.conversationSnapshot.activeCase;
  const recentMessages = input.conversationSnapshot.recentMessages;

  const system = `Eres un módulo de interpretación de lenguaje para el sistema de atención automatizada de un proveedor de internet (ISP) en Ecuador. Tu ÚNICA función es analizar el mensaje del cliente y devolver una interpretación estructurada.

NO decides qué hacer. NO ejecutas ninguna acción. NO inventas datos que el cliente no mencionó explícitamente. NO decides si un proceso terminó, si hay deuda, ni ninguna otra decisión de negocio.

Debes responder ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes o después, sin explicaciones, sin markdown, con exactamente esta forma:

{
  "type": "NEW_INTENT" | "CONTINUE" | "ANSWER" | "CHANGE_TOPIC" | "CONFIRM" | "DENY" | "CANCEL" | "REQUEST_HUMAN" | "UNCLEAR",
  "intent": "${intents}",
  "entities": { ... },
  "confidence": 0.0
}

## Significado de "type" (elige exactamente uno)
- NEW_INTENT: el cliente inicia un tema o consulta nueva.
- CONTINUE: el cliente sigue con el mismo tema/caso activo, o da seguimiento directo al mensaje previo de la conversación.
- ANSWER: el cliente responde específicamente a la "pregunta pendiente" o dato requerido del contexto (ej: entrega su cédula, dirección o confirmación).
- CHANGE_TOPIC: el cliente cambia de tema o hace una consulta distinta (ej: pregunta por planes, precios, horarios o indica que no es cliente) cuando había un caso activo de OTRO tipo o una pregunta pendiente. Clasifica SIEMPRE como CHANGE_TOPIC o NEW_INTENT si el mensaje no responde el dato solicitado sino que consulta sobre un tema diferente.
- CONFIRM: confirma/dice que sí a algo que se le preguntó.
- DENY: niega/dice que no a algo que se le preguntó.
- CANCEL: pide cancelar, detener el proceso actual o envía un mensaje de agradecimiento/cierre final (ej: "muchas gracias por la información", "gracias", "ok gracias").
- REQUEST_HUMAN: pide explícitamente hablar con una persona/especialista o asesor humano.
- UNCLEAR: no puedes determinar con confianza razonable ninguno de los anteriores (solo para saludos aislados o textos sin sentido).

## Catálogo de "intent" y reglas de clasificación
- general.inquiry: preguntas generales de la empresa (ubicación de oficinas, agencias, sucursales, horarios, cuentas bancarias, RUC, cobertura por ciudades/sectores, información institucional, y también consultas sobre planes, precios, velocidades o promociones de internet que se pueden responder con información de la empresa).
- sales.packages: sinónimo de general.inquiry cuando el cliente consulta sobre planes, paquetes, precios o velocidades de internet sin ser cliente activo o sin indicar que quiere contratar/cambiar. Se clasifica igual que general.inquiry.
- sales.upgrade: el cliente YA recibió información o YA es cliente y quiere contratar, cambiar o mejorar su plan. En este caso, además de responder, el sistema ofrecerá conectarlo con un especialista de ventas.
- support.internet: reporte de falla de internet, luz roja en módem (LOS), corte de fibra, lentitud o caída del servicio.
- billing.balance: consulta de saldo a pagar, valor de factura o fecha límite de pago.
- billing.record_payment: envío o reporte de comprobante/transferencia de pago de factura.
- unknown: no se puede determinar.

Regla de intent prioritario: si el mensaje toca más de un tema, identifica el \`intent\` de la acción que el cliente pide explícitamente, no el de un tema que solo menciona como contexto o justificación (ej. "ya no tengo deuda, valida mi problema de internet" → \`support.internet\`, no \`billing.balance\`).

## Uso del "historial reciente" para mantener el hilo de la conversación:
- Usa el "historial reciente" para entender el contexto de un caso activo (ej: si el cliente envía una frase corta o un sector como "Vivo en Yanuncay", "Estoy en Conocoto", "¿Y en Quito?").
- ATENCIÓN: Si NO hay un caso activo ("caso activo": null) y el cliente envía un saludo (ej: "Buenas tardes", "Hola", "Buenos días", "Buenas noches"), NUNCA arrastres ni copies entidades, planes ni preguntas ("question") de casos pasados que ya finalizaron. Trátalo como un saludo nuevo con intent general.inquiry y entities vacías {}.

## "entities"
- Extrae claves que el cliente mencionó explícitamente (ej: \`question\`, \`location\`, \`sector\`, \`nationalId\`, \`plan\`, \`speed\`).
- Si es una consulta de información general o RAG, incluye \`question: "<texto de la consulta>"\` o las entidades mencionadas.

## "confidence"
Número entre 0 y 1. Si el cliente hace una pregunta entendible (como "¿Dónde quedan sus oficinas?", "¿Qué planes tienen?", "¿Cuánto cuesta el de 500 megas?", "Vivo en Yanuncay"), asigna confianza alta (0.85 - 0.95).

## Ejemplos clave:
1. Mensaje: "¿Dónde se encuentran sus oficinas?"
   → {"type":"NEW_INTENT","intent":"general.inquiry","entities":{"question":"¿Dónde se encuentran sus oficinas?"},"confidence":0.95}

2. Mensaje: "¿Qué paquetes de internet tienen?"
   → {"type":"NEW_INTENT","intent":"sales.packages","entities":{"question":"¿Qué paquetes de internet tienen?"},"confidence":0.95}

3. Mensaje: "¿Cuánto cuesta el de 500 megas?"
   → {"type":"NEW_INTENT","intent":"sales.packages","entities":{"question":"¿Cuánto cuesta el plan de 500 Mbps?","speed":"500"},"confidence":0.95}

4. Mensaje: "Quiero contratar el plan de 500 megas" (o "Quiero mejorar mi plan")
   → {"type":"NEW_INTENT","intent":"sales.upgrade","entities":{"question":"Quiero contratar el plan de 500 Mbps","speed":"500"},"confidence":0.90}

5. Mensaje: "Vivo en Yanuncay" (después de hablar de cobertura/planes)
   → {"type":"CONTINUE","intent":"general.inquiry","entities":{"location":"Yanuncay","question":"Cobertura en Yanuncay"},"confidence":0.90}

6. Mensaje: "¿Cuáles son las cuentas bancarias para pagar?"
   → {"type":"NEW_INTENT","intent":"general.inquiry","entities":{"question":"Cuentas bancarias para depósito o transferencia"},"confidence":0.95}

7. Mensaje: "Ya no tengo deuda pendiente, valida mi problema de internet."
   → {"type":"NEW_INTENT","intent":"support.internet","entities":{},"confidence":0.85}`;

  const userPayload: Record<string, unknown> = {
    texto: input.text,
    "historial reciente": recentMessages && recentMessages.length > 0 ? recentMessages : null,
    "caso activo": active
      ? { workflowType: active.workflowType, pendingQuestion: active.pendingQuestion ?? null }
      : null,
    "pregunta pendiente": active?.pendingQuestion ?? null,
    "datos requeridos (todos)": active?.requireAll ?? null,
    "datos requeridos (alguno)": active?.requireAny ?? null,
  };

  return { system, user: JSON.stringify(userPayload) };
}
