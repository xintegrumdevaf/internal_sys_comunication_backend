import type { Pool } from "pg";
import type { Contract, Customer, CustomerWithDetails } from "../../domain/customer.entity";
import type { Tag } from "../../../tags/domain/tag.entity";
import type {
  CreateCustomerInput,
  CustomerRepositoryPort,
  ListCustomersFilter,
  UpdateCustomerInput,
  UpsertCustomerByNationalIdInput,
} from "../../application/ports/customer.repository.port";

type CustomerRow = {
  id: string;
  national_id: string | null;
  full_name: string | null;
  wa_phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

type TagRow = {
  customer_id: string;
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

type ContractRow = {
  id: string;
  customer_id: string;
  contract_number: string;
  sector: string | null;
  olt_name: string | null;
  pon: string | null;
  serial: string | null;
  router_model: string | null;
  address: string | null;
  status: string;
  created_at: Date;
};

type ConversationInfoRow = {
  customer_id: string;
  conversation_id: string;
  wa_profile_name: string | null;
  last_activity_at: Date;
};

function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    nationalId: row.national_id,
    fullName: row.full_name,
    waPhone: row.wa_phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapContract(row: ContractRow): Contract {
  return {
    id: row.id,
    customerId: row.customer_id,
    contractNumber: row.contract_number,
    sector: row.sector,
    oltName: row.olt_name,
    pon: row.pon,
    serial: row.serial,
    routerModel: row.router_model,
    address: row.address,
    status: row.status,
    createdAt: row.created_at,
  };
}

export class CustomerRepositoryPg implements CustomerRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<Customer | null> {
    const { rows } = await this.pool.query<CustomerRow>(`SELECT * FROM customer WHERE id = $1`, [id]);
    return rows[0] ? mapCustomer(rows[0]) : null;
  }

  async findByNationalId(nationalId: string): Promise<Customer | null> {
    const { rows } = await this.pool.query<CustomerRow>(
      `SELECT * FROM customer WHERE national_id = $1`,
      [nationalId],
    );
    return rows[0] ? mapCustomer(rows[0]) : null;
  }

  async findByWaPhone(waPhone: string): Promise<Customer | null> {
    const { rows } = await this.pool.query<CustomerRow>(
      `SELECT * FROM customer WHERE wa_phone = $1`,
      [waPhone],
    );
    return rows[0] ? mapCustomer(rows[0]) : null;
  }

  async findWithDetailsById(id: string): Promise<CustomerWithDetails | null> {
    const customer = await this.findById(id);
    if (!customer) return null;

    const [tags, contracts, convInfo] = await Promise.all([
      this.getTags(id),
      this.getContracts(id),
      this.getConversationInfo(id),
    ]);

    return {
      ...customer,
      tags,
      contracts,
      lastMessageAt: convInfo?.last_activity_at ?? null,
      waProfileName: convInfo?.wa_profile_name ?? null,
      conversationId: convInfo?.conversation_id ?? null,
    };
  }

  async upsertByNationalId(input: UpsertCustomerByNationalIdInput): Promise<Customer> {
    const { rows } = await this.pool.query<CustomerRow>(
      `INSERT INTO customer (national_id, full_name, wa_phone, email, address, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (national_id) DO UPDATE SET
         full_name = COALESCE(EXCLUDED.full_name, customer.full_name),
         wa_phone = COALESCE(EXCLUDED.wa_phone, customer.wa_phone),
         email = COALESCE(EXCLUDED.email, customer.email),
         address = COALESCE(EXCLUDED.address, customer.address),
         updated_at = now()
       RETURNING *`,
      [
        input.nationalId,
        input.fullName ?? null,
        input.waPhone ?? null,
        input.email ?? null,
        input.address ?? null,
      ],
    );
    return mapCustomer(rows[0]!);
  }

  async create(input: CreateCustomerInput): Promise<CustomerWithDetails> {
    const { rows } = await this.pool.query<CustomerRow>(
      `INSERT INTO customer (full_name, wa_phone, national_id, email, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.fullName,
        input.waPhone,
        input.nationalId ?? null,
        input.email ?? null,
        input.address ?? null,
        input.notes ?? null,
      ],
    );
    const customer = mapCustomer(rows[0]!);

    if (input.tagIds && input.tagIds.length > 0) {
      await this.setTags(customer.id, input.tagIds);
    }

    return (await this.findWithDetailsById(customer.id))!;
  }

  async update(id: string, input: UpdateCustomerInput): Promise<CustomerWithDetails | null> {
    const setClauses: string[] = ["updated_at = now()"];
    const params: unknown[] = [id];
    let idx = 2;

    if (input.fullName !== undefined) {
      setClauses.push(`full_name = $${idx++}`);
      params.push(input.fullName);
    }
    if (input.waPhone !== undefined) {
      setClauses.push(`wa_phone = $${idx++}`);
      params.push(input.waPhone);
    }
    if (input.nationalId !== undefined) {
      setClauses.push(`national_id = $${idx++}`);
      params.push(input.nationalId);
    }
    if (input.email !== undefined) {
      setClauses.push(`email = $${idx++}`);
      params.push(input.email);
    }
    if (input.address !== undefined) {
      setClauses.push(`address = $${idx++}`);
      params.push(input.address);
    }
    if (input.notes !== undefined) {
      setClauses.push(`notes = $${idx++}`);
      params.push(input.notes);
    }

    const { rows } = await this.pool.query<CustomerRow>(
      `UPDATE customer SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
      params,
    );

    if (!rows[0]) return null;

    if (input.tagIds !== undefined) {
      await this.setTags(id, input.tagIds);
    }

    return this.findWithDetailsById(id);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM customer WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async list(filter: ListCustomersFilter): Promise<{ customers: CustomerWithDetails[]; total: number }> {
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (filter.search) {
      const searchPattern = `%${filter.search}%`;
      whereClauses.push(
        `(c.full_name ILIKE $${idx} OR c.wa_phone ILIKE $${idx} OR c.national_id ILIKE $${idx} OR c.email ILIKE $${idx} OR EXISTS (SELECT 1 FROM contract ct WHERE ct.customer_id = c.id AND ct.contract_number ILIKE $${idx}))`,
      );
      params.push(searchPattern);
      idx++;
    }

    if (filter.tagId) {
      whereClauses.push(
        `EXISTS (SELECT 1 FROM customer_tag ct WHERE ct.customer_id = c.id AND ct.tag_id = $${idx})`,
      );
      params.push(filter.tagId);
      idx++;
    }

    if (filter.hasTags === true) {
      whereClauses.push(`EXISTS (SELECT 1 FROM customer_tag ct WHERE ct.customer_id = c.id)`);
    } else if (filter.hasTags === false) {
      whereClauses.push(`NOT EXISTS (SELECT 1 FROM customer_tag ct WHERE ct.customer_id = c.id)`);
    }

    if (filter.startDate) {
      whereClauses.push(`c.created_at >= $${idx}`);
      params.push(filter.startDate);
      idx++;
    }

    if (filter.endDate) {
      whereClauses.push(`c.created_at <= $${idx}`);
      params.push(filter.endDate);
      idx++;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    // 1. Total count
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customer c ${whereSql}`,
      params,
    );
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

    if (total === 0) {
      return { customers: [], total: 0 };
    }

    // 2. Fetch page
    const limit = filter.limit ?? 20;
    const offset = filter.offset ?? 0;
    const pageParams = [...params, limit, offset];
    const pageRows = await this.pool.query<CustomerRow>(
      `SELECT c.* FROM customer c
       ${whereSql}
       ORDER BY c.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      pageParams,
    );

    const customerIds = pageRows.rows.map((r) => r.id);

    // 3. Batch load tags, contracts, conversation info
    const [tagsByCustomer, contractsByCustomer, convByCustomer] = await Promise.all([
      this.batchGetTags(customerIds),
      this.batchGetContracts(customerIds),
      this.batchGetConversationInfo(customerIds),
    ]);

    const customers: CustomerWithDetails[] = pageRows.rows.map((row) => {
      const convInfo = convByCustomer.get(row.id);
      return {
        ...mapCustomer(row),
        tags: tagsByCustomer.get(row.id) ?? [],
        contracts: contractsByCustomer.get(row.id) ?? [],
        lastMessageAt: convInfo?.last_activity_at ?? null,
        waProfileName: convInfo?.wa_profile_name ?? null,
        conversationId: convInfo?.conversation_id ?? null,
      };
    });

    return { customers, total };
  }

  async setTags(customerId: string, tagIds: string[]): Promise<void> {
    await this.pool.query(`DELETE FROM customer_tag WHERE customer_id = $1`, [customerId]);
    if (tagIds.length === 0) return;

    const values = tagIds.map((_, i) => `($1, $${i + 2})`).join(", ");
    await this.pool.query(
      `INSERT INTO customer_tag (customer_id, tag_id)
       VALUES ${values}
       ON CONFLICT (customer_id, tag_id) DO NOTHING`,
      [customerId, ...tagIds],
    );
  }

  async getTags(customerId: string): Promise<Tag[]> {
    const { rows } = await this.pool.query<TagRow>(
      `SELECT ct.customer_id, t.*
       FROM customer_tag ct
       JOIN tag t ON t.id = ct.tag_id
       WHERE ct.customer_id = $1
       ORDER BY t.name ASC`,
      [customerId],
    );
    return rows.map(mapTag);
  }

  async linkConversationByPhone(customerId: string, waPhone: string): Promise<void> {
    await this.pool.query(
      `UPDATE conversation
       SET customer_id = $1, updated_at = now()
       WHERE wa_phone = $2 AND (customer_id IS NULL OR customer_id != $1)`,
      [customerId, waPhone],
    );
  }

  private async getContracts(customerId: string): Promise<Contract[]> {
    const { rows } = await this.pool.query<ContractRow>(
      `SELECT * FROM contract WHERE customer_id = $1 ORDER BY created_at ASC`,
      [customerId],
    );
    return rows.map(mapContract);
  }

  private async getConversationInfo(customerId: string): Promise<ConversationInfoRow | null> {
    const { rows } = await this.pool.query<ConversationInfoRow>(
      `SELECT id AS conversation_id, customer_id, wa_profile_name, last_activity_at
       FROM conversation
       WHERE customer_id = $1
       ORDER BY last_activity_at DESC
       LIMIT 1`,
      [customerId],
    );
    return rows[0] ?? null;
  }

  private async batchGetTags(customerIds: string[]): Promise<Map<string, Tag[]>> {
    const map = new Map<string, Tag[]>();
    if (customerIds.length === 0) return map;

    const { rows } = await this.pool.query<TagRow>(
      `SELECT ct.customer_id, t.*
       FROM customer_tag ct
       JOIN tag t ON t.id = ct.tag_id
       WHERE ct.customer_id = ANY($1::uuid[])
       ORDER BY t.name ASC`,
      [customerIds],
    );

    for (const row of rows) {
      const list = map.get(row.customer_id) ?? [];
      list.push(mapTag(row));
      map.set(row.customer_id, list);
    }
    return map;
  }

  private async batchGetContracts(customerIds: string[]): Promise<Map<string, Contract[]>> {
    const map = new Map<string, Contract[]>();
    if (customerIds.length === 0) return map;

    const { rows } = await this.pool.query<ContractRow>(
      `SELECT * FROM contract
       WHERE customer_id = ANY($1::uuid[])
       ORDER BY created_at ASC`,
      [customerIds],
    );

    for (const row of rows) {
      const list = map.get(row.customer_id) ?? [];
      list.push(mapContract(row));
      map.set(row.customer_id, list);
    }
    return map;
  }

  private async batchGetConversationInfo(customerIds: string[]): Promise<Map<string, ConversationInfoRow>> {
    const map = new Map<string, ConversationInfoRow>();
    if (customerIds.length === 0) return map;

    const { rows } = await this.pool.query<ConversationInfoRow>(
      `SELECT DISTINCT ON (customer_id)
         id AS conversation_id, customer_id, wa_profile_name, last_activity_at
       FROM conversation
       WHERE customer_id = ANY($1::uuid[])
       ORDER BY customer_id, last_activity_at DESC`,
      [customerIds],
    );

    for (const row of rows) {
      map.set(row.customer_id, row);
    }
    return map;
  }
}
