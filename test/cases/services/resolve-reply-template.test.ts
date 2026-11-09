import { describe, expect, it } from "vitest";
import { resolveReplyTemplate } from "../../../src/core/modules/cases/application/services/resolve-reply-template";
import { supportInternetWorkflow } from "../../../src/core/modules/cases/application/engine/definitions/support-internet.workflow";
import type { CaseContext } from "../../../src/core/modules/cases/domain/contexts/case-context";

describe("resolveReplyTemplate — WAITING_USER_DISAMBIGUATE", () => {
  it("formatea la lista de contratos con emojis numerados cuando hay pendingContracts", () => {
    const context: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1723456789", fullName: "Juan Perez" },
        pendingContracts: [
          {
            id: "1723456789-1",
            contractCode: "101",
            name: "Juan Perez",
            address: "Av. Amazonas N24-10, Piso 1",
            label: "Piso 1 - Av. Amazonas",
            sector: "pomasqui",
            oltName: "olt1",
            pon: "1",
            serial: "S1",
          },
          {
            id: "1723456789-2",
            contractCode: "102",
            name: "Juan Perez",
            address: "Av. Amazonas N24-10, Piso 2",
            label: "Piso 2 - Local",
            sector: "pomasqui",
            oltName: "olt2",
            pon: "2",
            serial: "S2",
          },
        ],
      },
    };

    const resolved = resolveReplyTemplate({
      definition: supportInternetWorkflow,
      outcome: {
        type: "WAITING_USER",
        nextState: "WAITING_USER_DISAMBIGUATE",
        context,
      },
      context,
    });

    expect(resolved.action).toBe("WAITING_USER_DISAMBIGUATE");
    expect(resolved.status).toBe("WAITING_USER");
    expect(resolved.templateHint).toContain("Encontré 2 contratos activos asociados a tu cédula");
    expect(resolved.templateHint).toContain("1️⃣ Piso 1 - Av. Amazonas");
    expect(resolved.templateHint).toContain("2️⃣ Piso 2 - Local");
    expect(resolved.templateHint).toContain("responde con el número 1, 2... o selecciónalo");
  });

  it("emite mensaje pedagógico claro si todos los contratos figuran como inactivos/anulados", () => {
    const context: CaseContext = {
      workflowType: "SUPPORT_INTERNET",
      data: {
        client: { nationalId: "1723456789", fullName: "Juan Perez" },
        lastSearchedNationalId: "1723456789",
        allContractsInactive: true,
      },
    };

    const resolved = resolveReplyTemplate({
      definition: supportInternetWorkflow,
      outcome: {
        type: "ESCALATED",
        reason: "Contratos del cliente figuran como anulados o retirados (sin servicio activo)",
        context,
      },
      context,
    });

    expect(resolved.action).toBe("ESCALATED");
    expect(resolved.status).toBe("ESCALATED");
    expect(resolved.templateHint).toContain("retirados o anulados");
    expect(resolved.templateHint).toContain("no registras un servicio de internet activo");
  });
});
