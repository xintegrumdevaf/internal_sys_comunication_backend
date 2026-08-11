/**
 * Dominio Customer / Contract (docs/spec/01_DATA_MODEL.md §2).
 * Usado por la reutilización de identidad (§14 de 02_STATE_MACHINE.md).
 */
export type Customer = {
  id: string;
  nationalId: string | null;
  fullName: string | null;
  waPhone: string | null;
  createdAt: Date;
};

export type Contract = {
  id: string;
  customerId: string;
  contractNumber: string;
  sector: string | null;
  oltName: string | null;
  pon: string | null;
  serial: string | null;
  routerModel: string | null;
  status: string;
  createdAt: Date;
};
