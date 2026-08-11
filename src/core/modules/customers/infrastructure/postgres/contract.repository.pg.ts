import type { Pool } from "pg";
import type { Contract } from "../../domain/customer.entity";
import type {
  ContractRepositoryPort,
  UpsertContractInput,
} from "../../application/ports/customer.repository.port";

type ContractRow = {
  id: string;
  customer_id: string;
  contract_number: string;
  sector: string | null;
  olt_name: string | null;
  pon: string | null;
  serial: string | null;
  router_model: string | null;
  status: string;
  created_at: Date;
};

function mapRow(row: ContractRow): Contract {
  return {
    id: row.id,
    customerId: row.customer_id,
    contractNumber: row.contract_number,
    sector: row.sector,
    oltName: row.olt_name,
    pon: row.pon,
    serial: row.serial,
    routerModel: row.router_model,
    status: row.status,
    createdAt: row.created_at,
  };
}

export class ContractRepositoryPg implements ContractRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async listActiveByCustomerId(customerId: string): Promise<Contract[]> {
    const { rows } = await this.pool.query<ContractRow>(
      `SELECT * FROM contract
       WHERE customer_id = $1 AND status = 'active'
       ORDER BY created_at ASC`,
      [customerId],
    );
    return rows.map(mapRow);
  }

  async upsertByCustomerAndNumber(input: UpsertContractInput): Promise<Contract> {
    const { rows } = await this.pool.query<ContractRow>(
      `INSERT INTO contract (
         customer_id, contract_number, sector, olt_name, pon, serial, router_model, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (customer_id, contract_number) DO UPDATE SET
         sector = COALESCE(EXCLUDED.sector, contract.sector),
         olt_name = COALESCE(EXCLUDED.olt_name, contract.olt_name),
         pon = COALESCE(EXCLUDED.pon, contract.pon),
         serial = COALESCE(EXCLUDED.serial, contract.serial),
         router_model = COALESCE(EXCLUDED.router_model, contract.router_model),
         status = EXCLUDED.status
       RETURNING *`,
      [
        input.customerId,
        input.contractNumber,
        input.sector ?? null,
        input.oltName ?? null,
        input.pon ?? null,
        input.serial ?? null,
        input.routerModel ?? null,
        input.status ?? "active",
      ],
    );
    return mapRow(rows[0]!);
  }
}
