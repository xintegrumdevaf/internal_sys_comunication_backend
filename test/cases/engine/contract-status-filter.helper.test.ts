import { describe, expect, it } from "vitest";
import {
  filterAndPrioritizeContracts,
  isContractInactive,
  isContractStrictlyActive,
  isContractSuspended,
  normalizeContractStatus,
} from "../../../src/core/modules/cases/application/helpers/contract-status-filter.helper";

describe("contract-status-filter.helper", () => {
  describe("normalizeContractStatus", () => {
    it("normaliza mayúsculas, espacios y acentos", () => {
      expect(normalizeContractStatus("  ACTIVO  ")).toBe("activo");
      expect(normalizeContractStatus("ANULADO")).toBe("anulado");
      expect(normalizeContractStatus("SusPensión")).toBe("suspension");
      expect(normalizeContractStatus(null)).toBe("");
      expect(normalizeContractStatus(undefined)).toBe("");
    });
  });

  describe("isContractStrictlyActive / Inactive / Suspended", () => {
    it("reconoce estados activos", () => {
      expect(isContractStrictlyActive("ACTIVO")).toBe(true);
      expect(isContractStrictlyActive("active")).toBe(true);
      expect(isContractStrictlyActive("ANULADO")).toBe(false);
    });

    it("reconoce estados inactivos / dados de baja", () => {
      expect(isContractInactive("ANULADO")).toBe(true);
      expect(isContractInactive("RETIRADO")).toBe(true);
      expect(isContractInactive("RECHAZADO")).toBe(true);
      expect(isContractInactive("INACTIVO")).toBe(true);
      expect(isContractInactive("inactive")).toBe(true);
      expect(isContractInactive("CANCELADO")).toBe(true);
      expect(isContractInactive("BAJA")).toBe(true);
      expect(isContractInactive("ACTIVO")).toBe(false);
    });

    it("reconoce estados suspendidos o cortados", () => {
      expect(isContractSuspended("CORTADO")).toBe(true);
      expect(isContractSuspended("SUSPENDIDO")).toBe(true);
      expect(isContractSuspended("MORA")).toBe(true);
      expect(isContractSuspended("ACTIVO")).toBe(false);
    });
  });

  describe("filterAndPrioritizeContracts", () => {
    it("retorna lista vacía si no hay contratos", () => {
      const res = filterAndPrioritizeContracts([]);
      expect(res.contracts).toEqual([]);
      expect(res.allContractsInactive).toBe(false);
    });

    it("descarta contratos ANULADOS o RETIRADOS cuando existe al menos 1 contrato ACTIVO", () => {
      const input = [
        { id: "101", status: "ANULADO" },
        { id: "102", status: "ACTIVO" },
        { id: "103", status: "RETIRADO" },
      ];
      const res = filterAndPrioritizeContracts(input);
      expect(res.contracts).toHaveLength(1);
      expect(res.contracts[0]!.id).toBe("102");
      expect(res.excludedInactiveCount).toBe(2);
      expect(res.hasStrictlyActive).toBe(true);
      expect(res.allContractsInactive).toBe(false);
    });

    it("retiene múltiples contratos activos para desambiguación limpia", () => {
      const input = [
        { id: "201", status: "ACTIVO", sector: "pomasqui" },
        { id: "202", status: "ANULADO", sector: "antiguo" },
        { id: "203", status: "ACTIVO", sector: "carcelen" },
      ];
      const res = filterAndPrioritizeContracts(input);
      expect(res.contracts).toHaveLength(2);
      expect(res.contracts.map((c) => c.id)).toEqual(["201", "203"]);
      expect(res.excludedInactiveCount).toBe(1);
    });

    it("prioriza contratos CORTADOS si no hay estrictamente activos", () => {
      const input = [
        { id: "301", status: "ANULADO" },
        { id: "302", status: "CORTADO" },
      ];
      const res = filterAndPrioritizeContracts(input);
      expect(res.contracts).toHaveLength(1);
      expect(res.contracts[0]!.id).toBe("302");
      expect(res.excludedInactiveCount).toBe(1);
      expect(res.hasStrictlyActive).toBe(false);
      expect(res.allContractsInactive).toBe(false);
    });

    it("marca allContractsInactive: true cuando TODOS los contratos están anulados/retirados", () => {
      const input = [
        { id: "401", status: "ANULADO" },
        { id: "402", status: "RETIRADO" },
        { id: "403", status: "RECHAZADO" },
      ];
      const res = filterAndPrioritizeContracts(input);
      expect(res.contracts).toHaveLength(0);
      expect(res.excludedInactiveCount).toBe(3);
      expect(res.allContractsInactive).toBe(true);
    });

    it("soporta contratos legados sin campo status descartando inactivos", () => {
      const input = [
        { id: "501" }, // sin status
        { id: "502", status: "ANULADO" },
      ];
      const res = filterAndPrioritizeContracts(input);
      expect(res.contracts).toHaveLength(1);
      expect(res.contracts[0]!.id).toBe("501");
      expect(res.excludedInactiveCount).toBe(1);
    });
  });
});

