/**
 * docs/spec/01_DATA_MODEL.md §4. El workflow que consume este contexto se
 * construye en la Etapa 8 — el tipo se declara ahora para que `CaseContext`
 * sea un discriminated union completo desde ya.
 */
export type BillingBalanceContext = {
  client?: { nationalId: string; fullName: string };
  invoices?: { id: string; amount: number; dueDate: string }[];
};
