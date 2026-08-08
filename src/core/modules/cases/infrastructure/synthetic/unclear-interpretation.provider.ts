import type { Interpretation, InterpretMessageInput, InterpretationPort } from "../../application/ports/interpretation.port";

/**
 * Implementacion temporal de `InterpretationPort` (docs/spec/05_BUILD_PLAN.md
 * Etapa 2: "se prueba con una interpretacion sintetica (fake), la real llega
 * en la Etapa 5"). Siempre devuelve `UNCLEAR`, que `CaseArbitrationService`
 * resuelve como `CLARIFY` sin crear/pausar/tocar ningun caso — mantiene el
 * pipeline buffer -> interpretacion -> arbitraje -> motor cableado de punta a
 * punta de forma segura mientras no exista un `AIProviderPort` real.
 *
 * Se reemplaza por el `OllamaAdapter` (AIProviderPort) en la Etapa 5 sin
 * tocar ningun otro archivo (Dependency Inversion).
 */
export class UnclearInterpretationProvider implements InterpretationPort {
  async interpretMessage(_input: InterpretMessageInput): Promise<Interpretation> {
    return { type: "UNCLEAR", intent: "unknown", entities: {}, confidence: 0 };
  }
}
