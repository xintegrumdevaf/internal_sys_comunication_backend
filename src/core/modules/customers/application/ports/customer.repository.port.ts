import type { Contract, Customer } from "../../domain/customer.entity";

export type UpsertCustomerByNationalIdInput = {
  nationalId: string;
  fullName?: string | null;
  waPhone?: string | null;
};

export type UpsertContractInput = {
  customerId: string;
  contractNumber: string;
  sector?: string | null;
  oltName?: string | null;
  pon?: string | null;
  serial?: string | null;
  routerModel?: string | null;
  status?: string;
};

export interface CustomerRepositoryPort {
  findById(id: string): Promise<Customer | null>;
  findByNationalId(nationalId: string): Promise<Customer | null>;
  upsertByNationalId(input: UpsertCustomerByNationalIdInput): Promise<Customer>;
}

export interface ContractRepositoryPort {
  listActiveByCustomerId(customerId: string): Promise<Contract[]>;
  upsertByCustomerAndNumber(input: UpsertContractInput): Promise<Contract>;
}
