import type { Pool } from "pg";
import type { Customer } from "../../domain/customer.entity";
import type {
  CustomerRepositoryPort,
  UpsertCustomerByNationalIdInput,
} from "../../application/ports/customer.repository.port";

type CustomerRow = {
  id: string;
  national_id: string | null;
  full_name: string | null;
  wa_phone: string | null;
  created_at: Date;
};

function mapRow(row: CustomerRow): Customer {
  return {
    id: row.id,
    nationalId: row.national_id,
    fullName: row.full_name,
    waPhone: row.wa_phone,
    createdAt: row.created_at,
  };
}

export class CustomerRepositoryPg implements CustomerRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<Customer | null> {
    const { rows } = await this.pool.query<CustomerRow>(`SELECT * FROM customer WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByNationalId(nationalId: string): Promise<Customer | null> {
    const { rows } = await this.pool.query<CustomerRow>(
      `SELECT * FROM customer WHERE national_id = $1`,
      [nationalId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async upsertByNationalId(input: UpsertCustomerByNationalIdInput): Promise<Customer> {
    const { rows } = await this.pool.query<CustomerRow>(
      `INSERT INTO customer (national_id, full_name, wa_phone)
       VALUES ($1, $2, $3)
       ON CONFLICT (national_id) DO UPDATE SET
         full_name = COALESCE(EXCLUDED.full_name, customer.full_name),
         wa_phone = COALESCE(EXCLUDED.wa_phone, customer.wa_phone)
       RETURNING *`,
      [input.nationalId, input.fullName ?? null, input.waPhone ?? null],
    );
    return mapRow(rows[0]!);
  }
}
