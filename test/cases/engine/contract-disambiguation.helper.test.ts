import { describe, expect, it } from "vitest";
import {
  calculateCharacterSimilarity,
  diceBigramSimilarity,
  levenshteinDistance,
  normalizeDisambiguationString,
  resolveContractDisambiguation,
} from "../../../src/core/modules/cases/application/engine/contract-disambiguation.helper";

describe("contract-disambiguation.helper", () => {
  const pendingContracts = [
    {
      id: "10542",
      contractCode: "10542",
      name: "Juan Perez",
      address: "Av. Manuel Córdova Galarza OE4-123 y Simón Bolívar",
      label: "Casa Pomasqui",
      sector: "Pomasqui",
      oltName: "OLT-POM-01",
      pon: "1",
      serial: "PON10542",
    },
    {
      id: "20984",
      contractCode: "20984",
      name: "Juan Perez",
      address: "Calle Diego de Vásquez N54-20 y Bellavista",
      label: "Oficina Norte",
      sector: "Carcelén",
      oltName: "OLT-CAR-02",
      pon: "2",
      serial: "PON20984",
    },
  ];

  it("normaliza cadenas removiendo acentos, espacios y mayúsculas", () => {
    expect(normalizeDisambiguationString("  Pomasquí  ")).toBe("pomasqui");
    expect(normalizeDisambiguationString("Carcelén")).toBe("carcelen");
    expect(normalizeDisambiguationString("Córdova Vásquez")).toBe("cordova vasquez");
  });

  describe("Resolución por opción numérica y ordinal", () => {
    it("resuelve por selectedOption numérica 1 y 2", () => {
      const res1 = resolveContractDisambiguation({
        pending: pendingContracts,
        entities: { selectedOption: 1 },
      });
      expect(res1.matched?.id).toBe("10542");
      expect(res1.matchType).toBe("option");

      const res2 = resolveContractDisambiguation({
        pending: pendingContracts,
        entities: { selectedOption: 2 },
      });
      expect(res2.matched?.id).toBe("20984");
    });

    it("resuelve por texto ordinal (el primero, la segunda, primero, segundo)", () => {
      expect(
        resolveContractDisambiguation({
          pending: pendingContracts,
          text: "el primero",
        }).matched?.id,
      ).toBe("10542");

      expect(
        resolveContractDisambiguation({
          pending: pendingContracts,
          text: "la segunda",
        }).matched?.id,
      ).toBe("20984");

      expect(
        resolveContractDisambiguation({
          pending: pendingContracts,
          text: "1ro por favor",
        }).matched?.id,
      ).toBe("10542");

      expect(
        resolveContractDisambiguation({
          pending: pendingContracts,
          text: "opcion 2",
        }).matched?.id,
      ).toBe("20984");
    });

    it("resuelve por botón interactivo con prefijo (1. Casa Pomasqui)", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "1. Casa Pomasqui (Pomasqui)",
      });
      expect(res.matched?.id).toBe("10542");
    });
  });

  describe("Resolución por número o código de contrato", () => {
    it("resuelve si el usuario escribe su número de contrato directamente", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "10542",
      });
      expect(res.matched?.id).toBe("10542");
      expect(res.matchType).toBe("contract_code");
    });

    it("resuelve si el usuario escribe 'el contrato 20984' o '#20984'", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el contrato 20984 por favor",
      });
      expect(res.matched?.id).toBe("20984");
      expect(res.matchType).toBe("contract_code");
    });

    it("si selectedOption vino con un número de contrato largo (ej. 10542), lo mapea al contrato correcto", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        entities: { selectedOption: 10542 },
      });
      expect(res.matched?.id).toBe("10542");
      expect(res.matchType).toBe("contract_code");
    });
  });

  describe("Resolución por Sector con lenguaje natural y tildes", () => {
    it("resuelve cuando el cliente dice 'el de pomasqui' o 'Pomasqui'", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el de pomasqui",
      });
      expect(res.matched?.id).toBe("10542");
      expect(res.matchType).toBe("sector");
    });

    it("resuelve cuando el cliente dice 'el que está en Pomasquí' (con tilde)", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el que está en Pomasquí",
      });
      expect(res.matched?.id).toBe("10542");
      expect(res.matchType).toBe("sector");
    });

    it("resuelve cuando el cliente menciona 'Carcelén' o 'el de carcelen'", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "en Carcelen tengo el problema",
      });
      expect(res.matched?.id).toBe("20984");
      expect(res.matchType).toBe("sector");
    });

    it("resuelve si el NLU extrae entities.sector", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        entities: { sector: "Carcelén" },
      });
      expect(res.matched?.id).toBe("20984");
      expect(res.matchType).toBe("sector");
    });
  });

  describe("Resolución por Tipo de Inmueble (Casa, Oficina, Local)", () => {
    it("resuelve cuando el cliente dice 'la de mi casa'", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "la de mi casa",
      });
      expect(res.matched?.id).toBe("10542");
      expect(res.matchType).toBe("label");
    });

    it("resuelve cuando el cliente dice 'el de la oficina'", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el que está en mi oficina",
      });
      expect(res.matched?.id).toBe("20984");
      expect(res.matchType).toBe("label");
    });
  });

  describe("Resolución por tokens de dirección y nombres de calle", () => {
    it("resuelve cuando el cliente menciona el nombre de la calle 'Córdova Galarza'", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el que queda en la cordova galarza",
      });
      expect(res.matched?.id).toBe("10542");
      expect(res.matchType).toBe("address");
    });

    it("resuelve cuando el cliente menciona 'Diego de Vásquez'", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "en la calle diego de vasquez",
      });
      expect(res.matched?.id).toBe("20984");
      expect(res.matchType).toBe("address");
    });

    it("resuelve cuando el cliente menciona 'Bellavista'", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el de bellavista",
      });
      expect(res.matched?.id).toBe("20984");
      expect(res.matchType).toBe("address");
    });
  });

  describe("Análisis de coincidencia de caracteres y tolerancia a erratas (anti-rigidez)", () => {
    it("calcula similitud de caracteres alta ante erratas de una letra o transposición", () => {
      expect(levenshteinDistance("pomasqui", "pomasqi")).toBe(1);
      expect(calculateCharacterSimilarity("pomasqui", "pomasqi")).toBeGreaterThan(0.8);
      expect(calculateCharacterSimilarity("carcelen", "carceln")).toBeGreaterThan(0.8);
      expect(calculateCharacterSimilarity("cordova", "cordoba")).toBeGreaterThan(0.8);
      expect(diceBigramSimilarity("pomasqui", "pomasqui")).toBe(1);
    });

    it("resuelve sector con errata de tipeo ('el de pomasqi' o 'el de carceln')", () => {
      const resPomasqi = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el que está en pomasqi",
      });
      expect(resPomasqi.matched?.id).toBe("10542");

      const resCarceln = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el de carceln por favor",
      });
      expect(resCarceln.matched?.id).toBe("20984");
    });

    it("resuelve calle con errata fonética o tipeo ('la manuel cordoba' o 'bellabista')", () => {
      const resCordoba = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el que queda en la manuel cordoba",
      });
      expect(resCordoba.matched?.id).toBe("10542");

      const resBellabista = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el servicio de bellabista",
      });
      expect(resBellabista.matched?.id).toBe("20984");
    });

    it("resuelve etiquetas con variaciones y diminutivos ('la casita', 'la oficna')", () => {
      const resCasita = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "el de mi casita",
      });
      expect(resCasita.matched?.id).toBe("10542");

      const resOficna = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "en mi oficna no hay internet",
      });
      expect(resOficna.matched?.id).toBe("20984");
    });
  });

  describe("Manejo de ambigüedad y entradas no concluyentes", () => {
    it("retorna none si el texto es ambiguo o no coincide", () => {
      const res = resolveContractDisambiguation({
        pending: pendingContracts,
        text: "hola buenas tardes",
      });
      expect(res.matched).toBeUndefined();
      expect(res.matchType).toBe("none");
    });

    it("retorna none si no hay contratos pendientes", () => {
      const res = resolveContractDisambiguation({
        pending: [],
        text: "pomasqui",
      });
      expect(res.matched).toBeUndefined();
      expect(res.matchType).toBe("none");
    });
  });
});

