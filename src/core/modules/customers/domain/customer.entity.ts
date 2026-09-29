import type { Tag } from "../../tags/domain/tag.entity";

/**
 * Dominio Customer / Contract (docs/spec/01_DATA_MODEL.md §2).
 * Usado por la reutilización de identidad (§14 de 02_STATE_MACHINE.md)
 * y el catálogo de contactos y clientes (migración 0033).
 */
export type Customer = {
  id: string;
  nationalId: string | null;
  fullName: string | null;
  waPhone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
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

export type CustomerWithDetails = Customer & {
  tags: Tag[];
  contracts: Contract[];
  lastMessageAt?: Date | null;
  waProfileName?: string | null;
  conversationId?: string | null;
};
