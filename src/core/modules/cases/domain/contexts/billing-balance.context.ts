/**
 * docs/spec/01_DATA_MODEL.md §4 — contexto tipado de BILLING_BALANCE (Etapa 8).
 */
export type BillingBalanceContext = {
  /** balance = consulta de saldo; record_payment = registrar comprobante; payment_methods = consulta de cuentas o formas de pago. */
  purpose?: "balance" | "record_payment" | "payment_methods";
  client?: { nationalId: string; fullName: string };
  lastSearchedNationalId?: string;
  clientNotFound?: boolean;
  invoices?: { id: string; amount: number; dueDate: string }[];
  balance?: { hasDebt: boolean; amount?: number };
  payment?: {
    amount?: number;
    reference?: string;
    date?: string;
    status?: "PENDING" | "RECORDED" | "REJECTED";
  };
};
