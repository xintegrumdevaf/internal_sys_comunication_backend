/**
 * docs/spec/01_DATA_MODEL.md §4. El workflow que consume este contexto se
 * construye en la Etapa 8 — el tipo se declara ahora para que `CaseContext`
 * sea un discriminated union completo desde ya.
 */
export type SalesPackagesContext = {
  requestedSpeed?: string;
  currentPlan?: { name: string; speed: string };
  offer?: { planId: string; price: number };
};
