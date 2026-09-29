import type { Tag } from "../../../tags/domain/tag.entity";
import type { Contract, Customer, CustomerWithDetails } from "../../domain/customer.entity";

export type UpsertCustomerByNationalIdInput = {
  nationalId: string;
  fullName?: string | null;
  waPhone?: string | null;
  email?: string | null;
  address?: string | null;
};

export type UpsertContractInput = {
  customerId: string;
  contractNumber: string;
  sector?: string | null;
  oltName?: string | null;
  pon?: string | null;
  serial?: string | null;
  routerModel?: string | null;
  address?: string | null;
  status?: string;
};

export type CreateCustomerInput = {
  fullName: string;
  waPhone: string;
  nationalId?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  tagIds?: string[];
};

export type UpdateCustomerInput = {
  fullName?: string | null;
  waPhone?: string | null;
  nationalId?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  tagIds?: string[];
};

export type ListCustomersFilter = {
  search?: string;
  tagId?: string;
  hasTags?: boolean;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
};

export interface CustomerRepositoryPort {
  findById(id: string): Promise<Customer | null>;
  findWithDetailsById(id: string): Promise<CustomerWithDetails | null>;
  findByNationalId(nationalId: string): Promise<Customer | null>;
  findByWaPhone(waPhone: string): Promise<Customer | null>;
  upsertByNationalId(input: UpsertCustomerByNationalIdInput): Promise<Customer>;
  create(input: CreateCustomerInput): Promise<CustomerWithDetails>;
  update(id: string, input: UpdateCustomerInput): Promise<CustomerWithDetails | null>;
  delete(id: string): Promise<boolean>;
  list(filter: ListCustomersFilter): Promise<{ customers: CustomerWithDetails[]; total: number }>;
  setTags(customerId: string, tagIds: string[]): Promise<void>;
  getTags(customerId: string): Promise<Tag[]>;
  linkConversationByPhone(customerId: string, waPhone: string): Promise<void>;
}

export interface ContractRepositoryPort {
  listActiveByCustomerId(customerId: string): Promise<Contract[]>;
  listByCustomerId(customerId: string): Promise<Contract[]>;
  upsertByCustomerAndNumber(input: UpsertContractInput): Promise<Contract>;
  deleteExcept(customerId: string, keepContractNumbers: string[]): Promise<void>;
}
