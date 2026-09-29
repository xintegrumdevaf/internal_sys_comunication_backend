import { describe, expect, it } from "vitest";
import type { Contract, Customer, CustomerWithDetails } from "../../src/core/modules/customers/domain/customer.entity";
import type { Tag } from "../../src/core/modules/tags/domain/tag.entity";
import type {
  ContractRepositoryPort,
  CreateCustomerInput,
  CustomerRepositoryPort,
  ListCustomersFilter,
  UpdateCustomerInput,
  UpsertContractInput,
  UpsertCustomerByNationalIdInput,
} from "../../src/core/modules/customers/application/ports/customer.repository.port";
import type {
  CreateTagInput,
  TagRepositoryPort,
  UpdateTagInput,
} from "../../src/core/modules/tags/application/ports/tag.repository.port";
import type { ExecuteActionParams, N8nActionResult, N8nGatewayPort } from "../../src/core/modules/cases/application/ports/n8n-gateway.port";

import { ListCustomersUseCase } from "../../src/core/modules/customers/application/use-cases/list-customers.use-case";
import { GetCustomerUseCase } from "../../src/core/modules/customers/application/use-cases/get-customer.use-case";
import { CreateCustomerUseCase } from "../../src/core/modules/customers/application/use-cases/create-customer.use-case";
import { UpdateCustomerUseCase } from "../../src/core/modules/customers/application/use-cases/update-customer.use-case";
import { DeleteCustomerUseCase } from "../../src/core/modules/customers/application/use-cases/delete-customer.use-case";
import { SyncCustomerIspUseCase } from "../../src/core/modules/customers/application/use-cases/sync-customer-isp.use-case";

class CustomerRepositoryFake implements CustomerRepositoryPort {
  public customers: Customer[] = [];
  public customerTags: Map<string, string[]> = new Map();
  public tagsCatalog: Tag[] = [];
  public linkedPhones: string[] = [];

  async findById(id: string): Promise<Customer | null> {
    return this.customers.find((c) => c.id === id) ?? null;
  }

  async findWithDetailsById(id: string): Promise<CustomerWithDetails | null> {
    const customer = await this.findById(id);
    if (!customer) return null;
    const tagIds = this.customerTags.get(id) ?? [];
    const tags = this.tagsCatalog.filter((t) => tagIds.includes(t.id));
    return {
      ...customer,
      tags,
      contracts: [],
      lastMessageAt: new Date("2026-09-29T10:00:00Z"),
      waProfileName: customer.fullName,
      conversationId: `conv-${customer.id}`,
    };
  }

  async findByNationalId(nationalId: string): Promise<Customer | null> {
    return this.customers.find((c) => c.nationalId === nationalId) ?? null;
  }

  async findByWaPhone(waPhone: string): Promise<Customer | null> {
    return this.customers.find((c) => c.waPhone === waPhone) ?? null;
  }

  async upsertByNationalId(input: UpsertCustomerByNationalIdInput): Promise<Customer> {
    let customer = await this.findByNationalId(input.nationalId);
    if (!customer) {
      customer = {
        id: `cust-${Date.now()}-${Math.random()}`,
        nationalId: input.nationalId,
        fullName: input.fullName ?? null,
        waPhone: input.waPhone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.customers.push(customer);
    } else {
      customer.fullName = input.fullName ?? customer.fullName;
      customer.waPhone = input.waPhone ?? customer.waPhone;
      customer.updatedAt = new Date();
    }
    return customer;
  }

  async create(input: CreateCustomerInput): Promise<CustomerWithDetails> {
    const customer: Customer = {
      id: `cust-${Date.now()}-${Math.random()}`,
      nationalId: input.nationalId ?? null,
      fullName: input.fullName,
      waPhone: input.waPhone,
      email: input.email ?? null,
      address: input.address ?? null,
      notes: input.notes ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.customers.push(customer);
    if (input.tagIds) {
      this.customerTags.set(customer.id, input.tagIds);
    }
    return (await this.findWithDetailsById(customer.id))!;
  }

  async update(id: string, input: UpdateCustomerInput): Promise<CustomerWithDetails | null> {
    const customer = await this.findById(id);
    if (!customer) return null;
    if (input.fullName !== undefined) customer.fullName = input.fullName;
    if (input.waPhone !== undefined) customer.waPhone = input.waPhone;
    if (input.nationalId !== undefined) customer.nationalId = input.nationalId;
    if (input.email !== undefined) customer.email = input.email;
    if (input.address !== undefined) customer.address = input.address;
    if (input.notes !== undefined) customer.notes = input.notes;
    customer.updatedAt = new Date();

    if (input.tagIds !== undefined) {
      this.customerTags.set(id, input.tagIds);
    }
    return this.findWithDetailsById(id);
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.customers.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    this.customers.splice(idx, 1);
    this.customerTags.delete(id);
    return true;
  }

  async list(filter: ListCustomersFilter): Promise<{ customers: CustomerWithDetails[]; total: number }> {
    let result = [...this.customers];

    if (filter.search) {
      const q = filter.search.toLowerCase();
      result = result.filter(
        (c) =>
          c.fullName?.toLowerCase().includes(q) ||
          c.waPhone?.toLowerCase().includes(q) ||
          c.nationalId?.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q),
      );
    }

    if (filter.tagId) {
      result = result.filter((c) => (this.customerTags.get(c.id) ?? []).includes(filter.tagId!));
    }

    if (filter.hasTags === true) {
      result = result.filter((c) => (this.customerTags.get(c.id) ?? []).length > 0);
    } else if (filter.hasTags === false) {
      result = result.filter((c) => (this.customerTags.get(c.id) ?? []).length === 0);
    }

    const total = result.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 20;
    const page = result.slice(offset, offset + limit);

    const detailed = await Promise.all(page.map((c) => this.findWithDetailsById(c.id)));
    return {
      customers: detailed.filter(Boolean) as CustomerWithDetails[],
      total,
    };
  }

  async setTags(customerId: string, tagIds: string[]): Promise<void> {
    this.customerTags.set(customerId, tagIds);
  }

  async getTags(customerId: string): Promise<Tag[]> {
    const tagIds = this.customerTags.get(customerId) ?? [];
    return this.tagsCatalog.filter((t) => tagIds.includes(t.id));
  }

  async linkConversationByPhone(_customerId: string, waPhone: string): Promise<void> {
    this.linkedPhones.push(waPhone);
  }
}

class ContractRepositoryFake implements ContractRepositoryPort {
  public contracts: Contract[] = [];

  async listActiveByCustomerId(customerId: string): Promise<Contract[]> {
    return this.contracts.filter((c) => c.customerId === customerId && c.status === "active");
  }

  async listByCustomerId(customerId: string): Promise<Contract[]> {
    return this.contracts.filter((c) => c.customerId === customerId);
  }

  async upsertByCustomerAndNumber(input: UpsertContractInput): Promise<Contract> {
    let contract = this.contracts.find(
      (c) => c.customerId === input.customerId && c.contractNumber === input.contractNumber,
    );
    if (!contract) {
      contract = {
        id: `contract-${Date.now()}-${Math.random()}`,
        customerId: input.customerId,
        contractNumber: input.contractNumber,
        sector: input.sector ?? null,
        oltName: input.oltName ?? null,
        pon: input.pon ?? null,
        serial: input.serial ?? null,
        routerModel: input.routerModel ?? null,
        status: input.status ?? "active",
        createdAt: new Date(),
      };
      this.contracts.push(contract);
    } else {
      contract.sector = input.sector ?? contract.sector;
      contract.status = input.status ?? contract.status;
    }
    return contract;
  }

  async deleteExcept(customerId: string, keepContractNumbers: string[]): Promise<void> {
    this.contracts = this.contracts.filter(
      (c) => c.customerId !== customerId || keepContractNumbers.includes(c.contractNumber),
    );
  }
}

class TagRepositoryFake implements TagRepositoryPort {
  public tags: Tag[] = [];

  async findAll(): Promise<Tag[]> {
    return this.tags;
  }
  async findById(id: string): Promise<Tag | null> {
    return this.tags.find((t) => t.id === id) ?? null;
  }
  async findByName(name: string): Promise<Tag | null> {
    return this.tags.find((t) => t.name.toUpperCase() === name.toUpperCase()) ?? null;
  }
  async create(input: CreateTagInput): Promise<Tag> {
    const tag: Tag = {
      id: `tag-${Date.now()}-${Math.random()}`,
      name: input.name.trim().toUpperCase(),
      description: input.description ?? null,
      color: input.color ?? null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tags.push(tag);
    return tag;
  }
  async update(id: string, input: UpdateTagInput): Promise<Tag | null> {
    const tag = await this.findById(id);
    if (!tag) return null;
    if (input.name) tag.name = input.name.trim().toUpperCase();
    return tag;
  }
  async delete(id: string): Promise<boolean> {
    const idx = this.tags.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.tags.splice(idx, 1);
    return true;
  }
}

class N8nGatewayFake implements N8nGatewayPort {
  public validateClientHandler?: (params: ExecuteActionParams) => Promise<N8nActionResult>;

  async executeAction(params: ExecuteActionParams): Promise<N8nActionResult> {
    if (params.action === "VALIDATE_CLIENT" && this.validateClientHandler) {
      return this.validateClientHandler(params);
    }
    return { success: true, result: { found: false } };
  }
}

describe("Módulo de Contactos / Clientes (Customers & Contacts)", () => {
  it("crea un nuevo contacto y vincula etiquetas y conversación", async () => {
    const customerRepo = new CustomerRepositoryFake();
    const tagRepo = new TagRepositoryFake();
    const tag = await tagRepo.create({ name: "VIP", color: "esmeralda" });
    customerRepo.tagsCatalog = tagRepo.tags;

    const createCustomer = new CreateCustomerUseCase(customerRepo);
    const created = await createCustomer.execute({
      fullName: "Janine Velez",
      waPhone: "593995200769",
      email: "janine@example.com",
      tagIds: [tag.id],
    });

    expect(created.fullName).toBe("Janine Velez");
    expect(created.waPhone).toBe("593995200769");
    expect(created.email).toBe("janine@example.com");
    expect(created.tags).toHaveLength(1);
    expect(created.tags[0]?.name).toBe("VIP");
    expect(customerRepo.linkedPhones).toContain("593995200769");
  });

  it("rechaza duplicados por teléfono o cédula al crear contacto", async () => {
    const customerRepo = new CustomerRepositoryFake();
    const createCustomer = new CreateCustomerUseCase(customerRepo);

    await createCustomer.execute({
      fullName: "Juan Perez",
      waPhone: "593987654321",
      nationalId: "1712345678",
    });

    // Mismo teléfono
    await expect(
      createCustomer.execute({
        fullName: "Otro Juan",
        waPhone: "593987654321",
      }),
    ).rejects.toThrow("Ya existe un contacto con el teléfono");

    // Misma cédula
    await expect(
      createCustomer.execute({
        fullName: "Tercer Juan",
        waPhone: "593911111111",
        nationalId: "1712345678",
      }),
    ).rejects.toThrow("Ya existe un cliente con la cédula");
  });

  it("lista contactos con filtros de búsqueda y paginación", async () => {
    const customerRepo = new CustomerRepositoryFake();
    const tagRepo = new TagRepositoryFake();
    const tagBellavista = await tagRepo.create({ name: "BELLAVISTA" });
    customerRepo.tagsCatalog = tagRepo.tags;

    const createCustomer = new CreateCustomerUseCase(customerRepo);
    await createCustomer.execute({
      fullName: "0000427 - GARCIA VELEZ",
      waPhone: "593983247516",
      nationalId: "0942783440",
      tagIds: [tagBellavista.id],
    });
    await createCustomer.execute({
      fullName: "Lucia Perez",
      waPhone: "593999999999",
    });

    const listCustomers = new ListCustomersUseCase(customerRepo);

    // Búsqueda por nombre o cédula
    const searchResult = await listCustomers.execute({ search: "0942783440" });
    expect(searchResult.data).toHaveLength(1);
    expect(searchResult.data[0]?.fullName).toContain("GARCIA VELEZ");

    // Filtro por etiqueta
    const tagFiltered = await listCustomers.execute({ tagId: tagBellavista.id });
    expect(tagFiltered.data).toHaveLength(1);
    expect(tagFiltered.data[0]?.tags[0]?.name).toBe("BELLAVISTA");

    // Contactos sin etiquetas
    const noTags = await listCustomers.execute({ hasTags: false });
    expect(noTags.data).toHaveLength(1);
    expect(noTags.data[0]?.fullName).toBe("Lucia Perez");
  });

  it("actualiza datos de un contacto y sus etiquetas", async () => {
    const customerRepo = new CustomerRepositoryFake();
    const createCustomer = new CreateCustomerUseCase(customerRepo);
    const updateCustomer = new UpdateCustomerUseCase(customerRepo);

    const created = await createCustomer.execute({
      fullName: "Carlos Gomez",
      waPhone: "593991234567",
    });

    const updated = await updateCustomer.execute(created.id, {
      fullName: "Carlos Gomez Actualizado",
      address: "Av. Principal 123",
      notes: "Cliente prefiere atención por la tarde",
    });

    expect(updated.fullName).toBe("Carlos Gomez Actualizado");
    expect(updated.address).toBe("Av. Principal 123");
    expect(updated.notes).toBe("Cliente prefiere atención por la tarde");
  });

  it("sincroniza datos técnicos con ISP (n8n), persiste contratos y auto-etiqueta por sector", async () => {
    const customerRepo = new CustomerRepositoryFake();
    const contractRepo = new ContractRepositoryFake();
    const tagRepo = new TagRepositoryFake();
    const n8nGateway = new N8nGatewayFake();

    customerRepo.tagsCatalog = tagRepo.tags;

    // Contacto inicial creado por un hijo o familiar (sin cédula aún)
    const createCustomer = new CreateCustomerUseCase(customerRepo);
    const contact = await createCustomer.execute({
      fullName: "Hijo de Don Juan",
      waPhone: "593998877665",
    });

    // Simula un contrato obsoleto previo que ya no existe en el ISP
    await contractRepo.upsertByCustomerAndNumber({
      customerId: contact.id,
      contractNumber: "1712345678",
      sector: "VIEJO",
    });

    // Mock de respuesta de n8n para VALIDATE_CLIENT con dos contratos para el titular
    n8nGateway.validateClientHandler = async (params) => {
      expect(params.input.id).toBe("1712345678");
      return {
        success: true,
        result: {
          found: true,
          contracts: [
            {
              id: "0000427",
              contractCode: "0000427",
              name: "JUAN PEREZ (TITULAR)",
              address: "Calle Los Pinos #45",
              status: "ACTIVO",
              router: {
                sector: "BELLAVISTA",
                olt_name: "bellavista",
                pon: "3",
                serial: "ALCLB123456",
              },
            },
            {
              id: "0000850",
              contractCode: "0000850",
              name: "JUAN PEREZ (TITULAR)",
              address: "Av. Shyris Local 4",
              status: "ACTIVO",
              router: {
                sector: "POMASQUI",
                olt_name: "pomasqui",
                pon: "1",
                serial: "ALCLB654321",
              },
            },
          ],
        },
      };
    };

    const syncCustomerIsp = new SyncCustomerIspUseCase({
      customerRepo,
      contractRepo,
      tagRepo,
      actionGateway: n8nGateway,
    });

    // Sincronizamos pasando la cédula del titular provista
    const result = await syncCustomerIsp.execute({
      customerId: contact.id,
      nationalId: "1712345678",
    });

    expect(result.contractsCount).toBe(2);
    expect(result.syncedSectors).toContain("BELLAVISTA");
    expect(result.syncedSectors).toContain("POMASQUI");

    // Datos del titular actualizados en el customer
    expect(result.customer.fullName).toBe("JUAN PEREZ (TITULAR)");
    expect(result.customer.address).toBe("Calle Los Pinos #45");
    expect(result.customer.nationalId).toBe("1712345678");

    // Ambos contratos persistidos en el repositorio de contratos
    const contractsInDb = await contractRepo.listByCustomerId(contact.id);
    expect(contractsInDb).toHaveLength(2);
    expect(contractsInDb.map((c) => c.contractNumber)).toEqual(["0000427", "0000850"]);

    // Auto-etiquetado generado en el catálogo y asignado al contacto
    const customerTags = await customerRepo.getTags(contact.id);
    const tagNames = customerTags.map((t) => t.name);
    expect(tagNames).toContain("BELLAVISTA");
    expect(tagNames).toContain("POMASQUI");
  });

  it("rechaza sincronización con ISP si no se dispone de la cédula del titular", async () => {
    const customerRepo = new CustomerRepositoryFake();
    const contractRepo = new ContractRepositoryFake();
    const tagRepo = new TagRepositoryFake();
    const n8nGateway = new N8nGatewayFake();

    const createCustomer = new CreateCustomerUseCase(customerRepo);
    const contact = await createCustomer.execute({
      fullName: "Cliente Sin Cedula",
      waPhone: "593990000000",
    });

    const syncCustomerIsp = new SyncCustomerIspUseCase({
      customerRepo,
      contractRepo,
      tagRepo,
      actionGateway: n8nGateway,
    });

    await expect(
      syncCustomerIsp.execute({ customerId: contact.id }),
    ).rejects.toThrow("Se requiere la cédula del titular");
  });
});
