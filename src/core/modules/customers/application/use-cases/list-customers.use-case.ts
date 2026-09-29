import type { CustomerWithDetails } from "../../domain/customer.entity";
import type { CustomerRepositoryPort, ListCustomersFilter } from "../ports/customer.repository.port";

export type ListCustomersResult = {
  data: CustomerWithDetails[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

export type ListCustomersParams = {
  search?: string;
  tagId?: string;
  hasTags?: boolean;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
};

export class ListCustomersUseCase {
  constructor(private readonly customerRepo: CustomerRepositoryPort) {}

  async execute(params: ListCustomersParams = {}): Promise<ListCustomersResult> {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.max(1, Math.min(100, params.limit ?? 20));
    const offset = (page - 1) * limit;

    const filter: ListCustomersFilter = {
      search: params.search?.trim() || undefined,
      tagId: params.tagId?.trim() || undefined,
      hasTags: params.hasTags,
      startDate: params.startDate ? new Date(params.startDate) : undefined,
      endDate: params.endDate ? new Date(params.endDate) : undefined,
      limit,
      offset,
    };

    const { customers, total } = await this.customerRepo.list(filter);
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      data: customers,
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    };
  }
}
