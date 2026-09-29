import { createHash, randomUUID } from "node:crypto";
import { notFound, validationError } from "../../../../../shared/errors/domain-errors";
import type { CustomerWithDetails } from "../../domain/customer.entity";
import type {
  ContractRepositoryPort,
  CustomerRepositoryPort,
} from "../ports/customer.repository.port";
import type { TagRepositoryPort } from "../../../tags/application/ports/tag.repository.port";
import type { N8nGatewayPort } from "../../../cases/application/ports/n8n-gateway.port";

export type SyncCustomerIspInput = {
  customerId: string;
  nationalId?: string;
};

export type SyncCustomerIspResult = {
  customer: CustomerWithDetails;
  contractsCount: number;
  syncedSectors: string[];
};

type IspContractPayload = {
  id?: string | number;
  contractCode?: string | number;
  name?: string;
  address?: string;
  email?: string;
  phone?: string;
  status?: string;
  router?: {
    sector?: string;
    olt_name?: string;
    pon?: string;
    serial?: string;
    ip?: string;
    model?: string;
  };
};

export class SyncCustomerIspUseCase {
  constructor(
    private readonly deps: {
      customerRepo: CustomerRepositoryPort;
      contractRepo: ContractRepositoryPort;
      tagRepo: TagRepositoryPort;
      actionGateway: N8nGatewayPort;
    },
  ) {}

  async execute(input: SyncCustomerIspInput): Promise<SyncCustomerIspResult> {
    const customer = await this.deps.customerRepo.findById(input.customerId);
    if (!customer) {
      throw notFound(`Contacto/Cliente con id '${input.customerId}' no encontrado`);
    }

    const nationalId = input.nationalId?.trim() || customer.nationalId?.trim();
    if (!nationalId) {
      throw validationError("Se requiere la cédula del titular para sincronizar con el ISP");
    }

    const correlationId = `sync-isp-${Date.now()}`;
    const executionId = randomUUID();
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ id: nationalId }))
      .digest("hex")
      .slice(0, 16);
    const idempotencyKey = `customer-sync:${customer.id}:${inputHash}:${Date.now()}`;

    const actionResult = await this.deps.actionGateway.executeAction({
      action: "VALIDATE_CLIENT",
      caseId: `sync-${customer.id}`,
      conversationId: `sync-${customer.id}`,
      correlationId,
      executionId,
      idempotencyKey,
      input: { id: nationalId },
    });

    if (!actionResult.success) {
      if (
        actionResult.error.type === "NOT_FOUND" ||
        actionResult.error.message?.toLowerCase().includes("not found") ||
        actionResult.error.message?.toLowerCase().includes("no se encontr")
      ) {
        throw notFound(`No se encontraron contratos registrados en el ISP para la cédula ${nationalId}`);
      }
      throw validationError(`Error al consultar el ISP: ${actionResult.error.message}`);
    }

    const rawResult = actionResult.result as {
      found?: boolean;
      email?: string;
      contracts?: IspContractPayload[];
    };

    const contracts = rawResult.contracts ?? [];
    if (!rawResult.found || contracts.length === 0) {
      throw notFound(`No se encontraron contratos registrados en el ISP para la cédula ${nationalId}`);
    }

    // 1. Extraer nombre, dirección y correo oficial del primer contrato si aplica
    const firstContract = contracts[0]!;
    const titularName = firstContract.name?.trim() || customer.fullName;
    const titularAddress = firstContract.address?.trim() || customer.address;
    const titularEmail =
      rawResult.email?.trim() ||
      contracts.find((c) => c.email?.trim())?.email?.trim() ||
      customer.email;

    await this.deps.customerRepo.update(customer.id, {
      nationalId,
      fullName: titularName,
      address: titularAddress,
      email: titularEmail ?? null,
    });

    // 2. Persistir/actualizar cada contrato asociado al titular
    const sectorsSet = new Set<string>();
    const syncedContractNumbers: string[] = [];

    for (let i = 0; i < contracts.length; i++) {
      const c = contracts[i]!;
      const rawCode = c.contractCode ?? c.id;
      const contractNumber = String(
        rawCode && (contracts.length === 1 || String(rawCode) !== nationalId)
          ? rawCode
          : `${nationalId}-${i + 1}`,
      ).trim();
      if (!contractNumber) continue;

      syncedContractNumbers.push(contractNumber);

      const sector = c.router?.sector ? c.router.sector.trim().toUpperCase() : null;
      if (sector) {
        sectorsSet.add(sector);
      }

      await this.deps.contractRepo.upsertByCustomerAndNumber({
        customerId: customer.id,
        contractNumber,
        sector,
        oltName: c.router?.olt_name ?? null,
        pon: c.router?.pon ?? null,
        serial: c.router?.serial ?? null,
        routerModel: c.router?.model ?? null,
        status: c.status?.toLowerCase() ?? "active",
      });
    }

    // Limpiar contratos obsoletos que ya no pertenezcan al titular en el ISP
    await this.deps.contractRepo.deleteExcept(customer.id, syncedContractNumbers);

    // 3. Auto-etiquetado por sectores encontrados
    const currentTags = await this.deps.customerRepo.getTags(customer.id);
    const existingTagIds = new Set(currentTags.map((t) => t.id));
    const syncedSectors: string[] = [];

    for (const sectorName of sectorsSet) {
      syncedSectors.push(sectorName);
      let tag = await this.deps.tagRepo.findByName(sectorName);
      if (!tag) {
        tag = await this.deps.tagRepo.create({
          name: sectorName,
          description: `Sector de cobertura ISP`,
          color: "#0284c7",
        });
      }
      existingTagIds.add(tag.id);
    }

    if (existingTagIds.size > currentTags.length) {
      await this.deps.customerRepo.setTags(customer.id, Array.from(existingTagIds));
    }

    const updatedCustomer = await this.deps.customerRepo.findWithDetailsById(customer.id);

    return {
      customer: updatedCustomer!,
      contractsCount: contracts.length,
      syncedSectors,
    };
  }
}
